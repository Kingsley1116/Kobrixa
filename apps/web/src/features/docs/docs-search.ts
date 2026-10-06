import { DIAGNOSTIC_HELP, DIAGNOSTIC_HELP_VARIANTS } from "@kobrixa/compiler/diagnostic-help";
import { apiEntries, apiRoute, describeApi, syntaxEntries } from "./basic-plus-reference.js";
import { documents, tutorials, type DocsLocale } from "./docs-content.js";

export type SearchKind = "tutorial" | "document" | "api" | "syntax" | "diagnostic";
export interface SearchEntry {
  path: string;
  kind: SearchKind;
  title: string;
  body: string;
  text: string;
}
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const plainText = (value: string) =>
  value
    .replace(/```[^\n]*\n/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const indexes = new Map<DocsLocale, SearchEntry[]>();
export function documentationIndex(locale: DocsLocale): readonly SearchEntry[] {
  const cached = indexes.get(locale);
  if (cached) return cached;
  const entries: SearchEntry[] = [];
  const add = (kind: SearchKind, path: string, title: string, body: string, keywords = "") => {
    const text = plainText(body);
    entries.push({
      kind,
      path,
      title,
      body: text,
      text: normalize(`${title} ${text} ${keywords}`),
    });
  };
  for (const lesson of tutorials)
    add(
      "tutorial",
      `/docs/tutorial/${lesson.slug}`,
      lesson.title[locale],
      `${lesson.summary[locale]} ${lesson.content[locale]}`,
      Object.values(lesson.title).join(" "),
    );
  for (const document of documents)
    add(
      "document",
      `/docs/reference/${document.slug}`,
      document.title[locale],
      `${document.summary[locale]} ${document.content[locale]}`,
      Object.values(document.title).join(" "),
    );
  for (const operation of apiEntries)
    add(
      "api",
      apiRoute(operation),
      operation.name,
      describeApi(operation, locale),
      operation.category,
    );
  for (const syntax of syntaxEntries)
    add(
      "syntax",
      `/docs/reference/basic-plus/syntax/${syntax.slug}`,
      syntax.title[locale],
      `${syntax.body[locale]} ${syntax.code}`,
    );
  for (const help of DIAGNOSTIC_HELP) {
    const variants = [
      help,
      ...DIAGNOSTIC_HELP_VARIANTS.filter((entry) => entry.code === help.code),
    ];
    add(
      "diagnostic",
      `/docs/diagnostics/${help.code}`,
      `${help.code} · ${help.title[locale]}`,
      variants
        .map(
          (entry) =>
            `${entry.cause[locale]} ${entry.steps[locale].join(" ")} ${entry.example?.before ?? ""} ${entry.example?.after ?? ""}`,
        )
        .join(" "),
      variants.flatMap((entry) => [...Object.values(entry.title), ...entry.keywords]).join(" "),
    );
  }
  indexes.set(locale, entries);
  return entries;
}

export function searchDocumentation(query: string, locale: DocsLocale): SearchEntry[] {
  const needle = normalize(query.trim().slice(0, 200));
  if (!needle) return [];
  const terms = needle.split(/\s+/).slice(0, 16);
  return documentationIndex(locale)
    .filter((entry) => terms.every((term) => entry.text.includes(term)))
    .map((entry) => {
      const title = normalize(entry.title);
      return {
        entry,
        score:
          (title === needle
            ? 100
            : title.startsWith(needle)
              ? 60
              : title.includes(needle)
                ? 40
                : 0) +
          terms.filter((term) => title.includes(term)).length * 10,
      };
    })
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, locale))
    .map(({ entry }) => entry);
}

export function searchExcerpt(entry: SearchEntry, query: string): string {
  const term = normalize(query.trim()).split(/\s+/)[0] ?? "";
  const index = term ? normalize(entry.body).indexOf(term) : 0;
  const start = Math.max(0, index - 45);
  const excerpt = entry.body.slice(start, start + 180);
  return `${start ? "…" : ""}${excerpt}${start + excerpt.length < entry.body.length ? "…" : ""}`;
}
