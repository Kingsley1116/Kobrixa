import type { ReactNode } from "react";
import type { DocsLocale } from "./docs-content.js";
import "./styles/prose.css";

type MarkdownHeadingProps = {
  level: 2 | 3;
  id: string;
  locale: DocsLocale;
  children?: ReactNode | undefined;
};

/** Article heading with a hover/focus-revealed `#` permalink after the text. */
export function MarkdownHeading({ level, id, locale, children }: MarkdownHeadingProps) {
  const Tag = level === 2 ? "h2" : "h3";
  if (!id) return <Tag>{children}</Tag>;
  const label = locale === "zh-TW" ? "連結到此段落" : "Link to this section";
  return (
    <Tag id={id} className="prose-heading">
      {children}
      <a className="heading-anchor" href={`#${id}`} aria-label={label} aria-describedby={id}>
        <span aria-hidden="true">#</span>
      </a>
    </Tag>
  );
}
