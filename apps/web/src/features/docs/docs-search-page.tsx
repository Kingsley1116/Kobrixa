import { useEffect, useId, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { AppLink } from "../../components/app-link.js";
import type { DocsLocale } from "./docs-content.js";
import { searchDocumentation, searchExcerpt } from "./docs-search.js";
import "./docs-search.css";

const ui = {
  "zh-TW": {
    title: "搜尋所有文件",
    intro: "搜尋教學、API、語法、使用說明與錯誤代碼。",
    label: "搜尋關鍵字",
    placeholder: "例如 Sensor.Read、BP1013、循線",
    clear: "清除搜尋",
    empty: "沒有符合的文件。試試較短的關鍵字或 API 名稱。",
    start: "輸入關鍵字開始搜尋。也可以直接輸入診斷代碼。",
    count: (total: number) => `找到 ${total} 筆結果${total > 50 ? "，顯示前 50 筆" : ""}`,
    kinds: {
      tutorial: "教學",
      document: "使用說明",
      api: "API",
      syntax: "語法",
      diagnostic: "錯誤解說",
    },
  },
  en: {
    title: "Search all documentation",
    intro: "Search tutorials, APIs, syntax, guides, and diagnostic codes.",
    label: "Search keywords",
    placeholder: "For example Sensor.Read, BP1013, motors",
    clear: "Clear search",
    empty: "No matching documents. Try a shorter keyword or an API name.",
    start: "Enter keywords or a diagnostic code to start searching.",
    count: (total: number) =>
      `${total} ${total === 1 ? "result" : "results"}${total > 50 ? "; showing the first 50" : ""}`,
    kinds: {
      tutorial: "Tutorial",
      document: "Guide",
      api: "API",
      syntax: "Syntax",
      diagnostic: "Diagnostic",
    },
  },
};
export function DocsSearchPage({ locale }: { locale: DocsLocale }) {
  const t = ui[locale];
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").slice(0, 200);
  const results = useMemo(() => searchDocumentation(query, locale), [query, locale]);
  const change = (value: string) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  useEffect(() => {
    document.title = `${t.title} — Kobrixa`;
  }, [t.title]);
  return (
    <section className="docs-search-page">
      <h1>{t.title}</h1>
      <p>{t.intro}</p>
      <form role="search" aria-label={t.title} onSubmit={(event) => event.preventDefault()}>
        <label htmlFor={id}>{t.label}</label>
        <div className="docs-search-controls">
          <input
            ref={input}
            id={id}
            className="ui-control"
            type="search"
            value={query}
            maxLength={200}
            placeholder={t.placeholder}
            onChange={(event) => change(event.target.value)}
          />
          {query && (
            <button
              className="ui-button"
              type="button"
              onClick={() => {
                change("");
                input.current?.focus();
              }}
            >
              {t.clear}
            </button>
          )}
        </div>
      </form>
      <p role="status" aria-live="polite">
        {query.trim() ? t.count(results.length) : t.start}
      </p>
      {query.trim() && !results.length && <p>{t.empty}</p>}
      <ul className="docs-search-results">
        {results.slice(0, 50).map((entry) => (
          <li key={entry.path}>
            <span>{t.kinds[entry.kind]}</span>
            <h2>
              <AppLink href={`${entry.path}?lang=${locale}`}>{entry.title}</AppLink>
            </h2>
            <p>{searchExcerpt(entry, query)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
