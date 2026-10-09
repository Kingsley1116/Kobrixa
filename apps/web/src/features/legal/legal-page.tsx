import { Icon } from "../../components/ui/icon.js";
import { useEffect } from "react";
import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SiteHeader } from "../../components/site-header.js";
import type { PageContext } from "../../app/app.js";
import { legalContent, POLICY_DATE } from "./legal-content.js";
import type { LegalKind } from "./legal-content.js";
import "./legal.css";

export function LegalPage({ kind, locale, onLocaleChange }: PageContext & { kind: LegalKind }) {
  const policy = legalContent(kind, locale);
  const zh = locale === "zh-TW";
  useEffect(() => {
    document.title = `${policy.title} — Kobrixa`;
  }, [policy.title]);
  return (
    <>
      <a className="skip-link" href="#content">
        {zh ? "跳到主要內容" : "Skip to main content"}
      </a>
      <SiteHeader locale={locale} page={kind} onLocaleChange={onLocaleChange} />
      <main id="content" className="legal-page">
        <header className="legal-heading">
          <p className="legal-eyebrow">KOBRIXA / {zh ? "使用與隱私" : "TERMS & PRIVACY"}</p>
          <h1>{policy.title}</h1>
          <p className="legal-date">
            {zh ? "更新與生效日期：" : "Updated and effective: "}
            <time dateTime={POLICY_DATE}>{POLICY_DATE}</time>
          </p>
          <p>{policy.intro}</p>
          <div className="legal-page-links">
            <Link to="/terms" aria-current={kind === "terms" ? "page" : undefined}>
              {zh ? "服務條款" : "Terms of Service"}
            </Link>
            <Link to="/privacy" aria-current={kind === "privacy" ? "page" : undefined}>
              {zh ? "隱私政策" : "Privacy Policy"}
            </Link>
            <Link to="/gallery">
              {zh ? "前往素材庫" : "Go to Gallery"} <Icon name="arrow" />
            </Link>
          </div>
        </header>
        <nav className="legal-contents" aria-label={zh ? "本頁目錄" : "On this page"}>
          {policy.sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
        </nav>
        <article className="legal-body" aria-label={policy.title}>
          {policy.sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h2>{section.title}</h2>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) =>
                    href?.startsWith("/") ? (
                      <Link to={href}>{children}</Link>
                    ) : (
                      <a
                        href={href}
                        {...(href?.startsWith("https:")
                          ? { target: "_blank", rel: "noreferrer" }
                          : {})}
                      >
                        {children}
                      </a>
                    ),
                  table: ({ children }) => (
                    <div
                      className="legal-table-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label={zh ? "儲存項目與期限" : "Storage and lifetime"}
                    >
                      <table>{children}</table>
                    </div>
                  ),
                }}
              >
                {section.body}
              </ReactMarkdown>
            </section>
          ))}
        </article>
      </main>
    </>
  );
}
