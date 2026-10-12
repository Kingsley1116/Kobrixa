import { useEffect, useId, useRef, useState } from "react";
import { AppLink } from "../../components/app-link.js";
import { Icon } from "../../components/ui/icon.js";
import { apiEntries, apiRoute, syntaxEntries } from "./basic-plus-reference.js";
import { documents, tutorials, type DocsLocale } from "./docs-content.js";
import "./styles/sidebar.css";

const github = "https://github.com/Kingsley1116/Kobrixa";

const labels = {
  "zh-TW": {
    docs: "文件",
    contents: "目錄",
    search: "搜尋所有文件",
    start: "開始使用",
    diagnostics: "錯誤索引",
    course: "完整課程",
    overview: "總覽",
    basicPlus: "Basic Plus 參考",
    syntax: "語法",
    functions: "API 函數",
    productDocs: "產品文件",
    technicalDocs: "技術文件",
    examples: "範例與學習",
    learningPath: "學習路徑",
    browseExamples: "所有範例",
  },
  en: {
    docs: "Documentation",
    contents: "Contents",
    search: "Search all documentation",
    start: "Get started",
    diagnostics: "Diagnostic index",
    course: "Full course",
    overview: "Overview",
    basicPlus: "Basic Plus reference",
    syntax: "Syntax",
    functions: "API functions",
    productDocs: "Product docs",
    technicalDocs: "Technical docs",
    examples: "Examples & learning",
    learningPath: "Learning path",
    browseExamples: "All examples",
  },
} as const;

const categoryLabels = {
  "zh-TW": {
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
  },
  en: {
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
  },
} as const;

/**
 * Documentation navigation tree. On wide screens it is a sticky, independently scrolling
 * column under the site navbar; at 720px and below it collapses into a "Contents" drawer
 * so the whole tree is not dumped above the article.
 */
export function KnowledgeSidebar({
  locale,
  activePath,
}: {
  locale: DocsLocale;
  activePath: string;
}) {
  const t = labels[locale];
  const sidebarRef = useRef<HTMLElement>(null);
  const navId = useId();
  // The drawer remembers which page it was opened on, so navigating closes it again.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const drawerOpen = openOn === activePath;
  const active = (path: string) =>
    activePath === path ||
    (path === "/docs/reference/basic-plus" && activePath.startsWith(`${path}/`))
      ? "active"
      : "";
  const inSection = (path: string) => activePath === path || activePath.startsWith(`${path}/`);
  const categories = categoryLabels[locale];
  useEffect(() => {
    if (!window.matchMedia("(min-width: 721px)").matches) return;
    // The deepest active link is the current page; a section overview may be active too.
    const activeLinks = sidebarRef.current?.querySelectorAll<HTMLAnchorElement>("a.active");
    activeLinks?.[activeLinks.length - 1]?.scrollIntoView({ block: "nearest" });
  }, [activePath]);
  return (
    <aside
      className={`doc-sidebar knowledge-sidebar${drawerOpen ? " is-open" : ""}`}
      aria-label={t.docs}
      ref={sidebarRef}
    >
      <button
        type="button"
        className="knowledge-sidebar-toggle"
        aria-expanded={drawerOpen}
        aria-controls={navId}
        onClick={() => setOpenOn(drawerOpen ? null : activePath)}
      >
        <Icon name="book" />
        <span>{t.contents}</span>
        <span className="knowledge-sidebar-toggle-mark" aria-hidden="true" />
      </button>
      <div className="knowledge-sidebar-nav" id={navId}>
        <AppLink
          className={`sidebar-parent sidebar-search ${active("/docs/search")}`}
          href={`/docs/search?lang=${locale}`}
        >
          <svg
            className="ui-icon"
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm5.3-2.2L21 21" />
          </svg>
          {t.search}
        </AppLink>
        <section>
          <p>{t.start}</p>
          <AppLink className={`sidebar-parent ${active("/docs")}`} href="/docs">
            {t.start}
          </AppLink>
          <AppLink
            className={`sidebar-parent ${inSection("/docs/diagnostics") ? "active" : ""}`}
            href={`/docs/diagnostics?lang=${locale}`}
            aria-current={inSection("/docs/diagnostics") ? "page" : undefined}
          >
            {t.diagnostics}
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
                document.category === "product" &&
                activePath === `/docs/reference/${document.slug}`,
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
            {t.learningPath}{" "}
            <span aria-hidden="true">
              <Icon name="external" />
            </span>
          </AppLink>
          <AppLink href={`${github}/tree/main/examples`} target="_blank" rel="noreferrer">
            {t.browseExamples}{" "}
            <span aria-hidden="true">
              <Icon name="external" />
            </span>
          </AppLink>
        </section>
      </div>
    </aside>
  );
}
