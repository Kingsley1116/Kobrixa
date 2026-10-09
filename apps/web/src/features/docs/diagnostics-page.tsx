import { Icon } from "../../components/ui/icon.js";
import {
  DIAGNOSTIC_HELP,
  DIAGNOSTIC_HELP_VARIANTS,
  getDiagnosticHelp,
  type DiagnosticHelp,
  type DiagnosticLocale,
} from "@kobrixa/compiler/diagnostic-help";
import { useEffect, useId, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { AppLink } from "../../components/app-link.js";
import { Select } from "../../components/ui/select.js";
import "./diagnostics.css";

const families = ["BP", "MAN", "IR", "EV3", "BUILD"] as const;
type Family = (typeof families)[number];
const ui = {
  "zh-TW": {
    title: "錯誤索引",
    intro: "依照診斷代碼查找原因、修正步驟與範例。這些解說也可在 Kobrixa 中離線閱讀。",
    search: "搜尋代碼、標題或關鍵字",
    placeholder: "例如 BP1013、括號、motor",
    family: "診斷類別",
    all: "所有類別",
    results: (count: number) => `${count} 個診斷代碼`,
    empty: "沒有符合的診斷代碼。請嘗試其他關鍵字或類別。",
    reset: "清除篩選",
    back: "返回錯誤索引",
    cause: "發生原因",
    steps: "處理步驟",
    before: "修正前",
    after: "修正後",
    related: "相關文件",
    variants: "這個代碼的其他原因",
    unknown: "找不到這個診斷代碼",
    unknownBody: "請確認代碼是否正確，或返回索引搜尋。較新版本的診斷可能尚未收錄。",
    familyNames: {
      BP: "BP · Basic Plus",
      MAN: "MAN · 專案設定",
      IR: "IR · 中介表示",
      EV3: "EV3 · 程式產生",
      BUILD: "BUILD · 建置",
    },
  },
  en: {
    title: "Diagnostic index",
    intro:
      "Find causes, repair steps, and examples by diagnostic code. These explanations are also available offline in Kobrixa.",
    search: "Search codes, titles, or keywords",
    placeholder: "For example BP1013, parentheses, motor",
    family: "Diagnostic family",
    all: "All families",
    results: (count: number) => `${count} diagnostic ${count === 1 ? "code" : "codes"}`,
    empty: "No matching diagnostic codes. Try another keyword or family.",
    reset: "Clear filters",
    back: "Back to diagnostic index",
    cause: "Why this happens",
    steps: "How to resolve it",
    before: "Before",
    after: "After",
    related: "Related documentation",
    variants: "Other causes for this code",
    unknown: "Diagnostic code not found",
    unknownBody:
      "Check the code or return to the index to search. Diagnostics from a newer version may not be listed yet.",
    familyNames: {
      BP: "BP · Basic Plus",
      MAN: "MAN · Project manifest",
      IR: "IR · Intermediate representation",
      EV3: "EV3 · Code generation",
      BUILD: "BUILD · Build",
    },
  },
} as const;

function diagnosticPath(locale: DiagnosticLocale, code?: string) {
  return `/docs/diagnostics${code ? `/${encodeURIComponent(code)}` : ""}?lang=${locale}`;
}

function diagnosticFamily(code: string) {
  return families.find((family) => code.startsWith(family));
}

const searchableEntries = DIAGNOSTIC_HELP.map((entry) => ({
  entry,
  text: [entry, ...DIAGNOSTIC_HELP_VARIANTS.filter((variant) => variant.code === entry.code)]
    .flatMap((help) => [
      help.code,
      help.title["zh-TW"],
      help.title.en,
      help.cause["zh-TW"],
      help.cause.en,
      ...help.steps["zh-TW"],
      ...help.steps.en,
      ...help.keywords,
    ])
    .join(" ")
    .toLocaleLowerCase(),
}));

function DiagnosticIndex({ locale }: { locale: DiagnosticLocale }) {
  const t = ui[locale];
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<Family | "all">("all");
  const results = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return searchableEntries
      .filter(
        ({ entry, text }) =>
          (family === "all" || diagnosticFamily(entry.code) === family) &&
          terms.every((term) => text.includes(term)),
      )
      .map(({ entry }) => entry);
  }, [query, family]);

  return (
    <div className="diagnostics-reference">
      <header className="diagnostics-header">
        <p className="eyebrow">Kobrixa</p>
        <h1>{t.title}</h1>
        <p>{t.intro}</p>
      </header>
      <div className="diagnostics-filters" role="search" aria-label={t.title}>
        <label htmlFor={searchId}>
          {t.search}
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder={t.placeholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="diagnostics-family">
          <span>{t.family}</span>
          <Select
            label={t.family}
            value={family}
            onValueChange={(value) => setFamily(value as Family | "all")}
            options={[
              { value: "all", label: t.all },
              ...families.map((value) => ({ value, label: t.familyNames[value] })),
            ]}
          />
        </div>
      </div>
      <p className="diagnostics-count" role="status" aria-live="polite" aria-atomic="true">
        {t.results(results.length)}
      </p>
      {results.length ? (
        <ul className="diagnostics-list">
          {results.map((entry) => (
            <li key={entry.code}>
              <AppLink href={diagnosticPath(locale, entry.code)}>
                <code>{entry.code}</code>
                <div>
                  <strong>{entry.title[locale]}</strong>
                  <p>{entry.cause[locale]}</p>
                </div>
                <span aria-hidden="true">
                  <Icon name="arrow" />
                </span>
              </AppLink>
            </li>
          ))}
        </ul>
      ) : (
        <div className="diagnostics-empty">
          <p>{t.empty}</p>
          <button
            className="button secondary"
            onClick={() => {
              setQuery("");
              setFamily("all");
            }}
          >
            {t.reset}
          </button>
        </div>
      )}
    </div>
  );
}

function HelpContent({ entry, locale }: { entry: DiagnosticHelp; locale: DiagnosticLocale }) {
  const t = ui[locale];
  const Heading = entry.helpKey ? "h3" : "h2";
  return (
    <>
      <Heading>{t.cause}</Heading>
      <p>{entry.cause[locale]}</p>
      <Heading>{t.steps}</Heading>
      <ol>
        {entry.steps[locale].map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      {entry.example ? (
        <div className="diagnostics-examples">
          {(["before", "after"] as const).map((part) => (
            <div key={part}>
              <h3>{t[part]}</h3>
              <pre>
                <code className={`language-${entry.example!.language}`}>
                  {entry.example![part]}
                </code>
              </pre>
            </div>
          ))}
        </div>
      ) : null}
      {entry.related.length ? (
        <div className="diagnostics-related">
          <Heading>{t.related}</Heading>
          <ul>
            {entry.related.map((link) => (
              <li key={link.path}>
                <AppLink href={link.path}>{link.label[locale]}</AppLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function DiagnosticsPage({
  locale,
  code,
}: {
  locale: DiagnosticLocale;
  code: string | undefined;
}) {
  const t = ui[locale];
  const entry = code ? getDiagnosticHelp(code) : undefined;
  const variants = entry
    ? DIAGNOSTIC_HELP_VARIANTS.filter((variant) => variant.code === entry.code)
    : [];
  const { hash } = useLocation();

  useEffect(() => {
    document.title = `${code ? (entry ? `${entry.code}: ${entry.title[locale]}` : t.unknown) : t.title} — Kobrixa`;
  }, [code, entry, locale, t]);

  useEffect(() => {
    if (!hash || !entry) return;
    try {
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
    } catch {
      // A malformed URL fragment should not prevent reading the diagnostic.
    }
  }, [code, hash, entry]);

  if (!code) return <DiagnosticIndex locale={locale} />;
  if (!entry)
    return (
      <article className="diagnostics-reference diagnostics-header">
        <h1>{t.unknown}</h1>
        <code>{code}</code>
        <p>{t.unknownBody}</p>
        <AppLink className="back-link" href={diagnosticPath(locale)}>
          <Icon name="arrow-left" /> {t.back}
        </AppLink>
      </article>
    );

  return (
    <article className="diagnostics-reference diagnostics-detail">
      <AppLink className="back-link" href={diagnosticPath(locale)}>
        <Icon name="arrow-left" /> {t.back}
      </AppLink>
      <header className="diagnostics-header">
        <code>{entry.code}</code>
        <h1>{entry.title[locale]}</h1>
      </header>
      {variants.length ? (
        <nav className="diagnostics-variants" aria-label={t.variants}>
          <p>{t.variants}</p>
          {variants.map((variant) => (
            <AppLink href={`#${variant.helpKey}`} key={variant.helpKey}>
              {variant.title[locale]}
            </AppLink>
          ))}
        </nav>
      ) : null}
      <section className="diagnostics-explanation" aria-label={entry.title[locale]}>
        <HelpContent entry={entry} locale={locale} />
      </section>
      {variants.map((variant) => (
        <section
          className="diagnostics-explanation"
          id={variant.helpKey}
          key={variant.helpKey}
          aria-labelledby={`${variant.helpKey}-title`}
        >
          <h2 id={`${variant.helpKey}-title`}>{variant.title[locale]}</h2>
          <HelpContent entry={variant} locale={locale} />
        </section>
      ))}
    </article>
  );
}
