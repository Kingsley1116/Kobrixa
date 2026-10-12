import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { Icon, type IconName } from "../../components/ui/icon.js";
import { calloutVariantFor, type CalloutVariant } from "./callout-label.js";
import "./styles/callout.css";

type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[] };

const icons: Record<CalloutVariant, IconName> = {
  note: "info",
  warning: "alert",
  safety: "shield",
  tip: "lightbulb",
};

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function firstElement(node: HastNode | undefined): HastNode | undefined {
  return node?.children?.find(
    (child) => child.type === "element" || (child.type === "text" && child.value?.trim()),
  );
}

/** Reads the bold label that opens a blockquote, e.g. `> **Version notes.** …`. */
function leadingLabel(node: HastNode | undefined): string | null {
  const paragraph = firstElement(node);
  if (paragraph?.tagName !== "p") return null;
  const strong = firstElement(paragraph);
  return strong?.tagName === "strong" ? hastText(strong) : null;
}

/**
 * Renders `> **Note.** …`-style blockquotes as callouts; any other blockquote stays a plain quote.
 * The label stays in the content so the Markdown source text is rendered unchanged.
 */
export function MarkdownCallout({
  node,
  children,
  ...props
}: ComponentProps<"blockquote"> & ExtraProps) {
  const label = leadingLabel(node as HastNode | undefined);
  const variant = label === null ? null : calloutVariantFor(label);
  if (!variant) return <blockquote {...props}>{children}</blockquote>;
  return (
    <div className={`docs-callout docs-callout--${variant}`} role="note">
      <span className="docs-callout-icon" aria-hidden="true">
        <Icon name={icons[variant]} />
      </span>
      <div className="docs-callout-body">{children}</div>
    </div>
  );
}
