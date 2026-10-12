import { isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../../components/ui/icon.js";
import { resolveCodeLanguage, tokenize } from "./code-highlight.js";
import "./styles/code.css";

type CodeElementProps = { className?: string; children?: ReactNode };

function textOf(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return textOf(value.props.children);
  return "";
}

/** Reads the `language-*` class and raw text from react-markdown's `<pre><code>` pair. */
function readFence(children: ReactNode): { className?: string | undefined; text: string } {
  const code = Array.isArray(children) ? children.find((child) => isValidElement(child)) : children;
  if (isValidElement<CodeElementProps>(code))
    return { className: code.props.className, text: textOf(code.props.children) };
  return { text: textOf(children) };
}

export function CopyCode({
  value,
  label,
  copiedLabel,
}: {
  value: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      className="copy-code"
      data-copied={copied || undefined}
      aria-live="polite"
      onClick={() => void copy()}
    >
      <Icon name={copied ? "check" : "copy"} />
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}

/**
 * Markdown `pre` override shared by reference articles and tutorials: a toolbar
 * with the fence's language and a copy button above a highlighted code body.
 */
export function MarkdownPre({
  children,
  copyLabel,
  copiedLabel,
}: {
  children?: ReactNode;
  copyLabel: string;
  copiedLabel: string;
}) {
  const { className, text } = readFence(children);
  const source = text.replace(/\n$/, "");
  const language = resolveCodeLanguage(className);
  const tokens = useMemo(() => tokenize(source, language.id), [source, language.id]);
  return (
    <div className="code-block" data-language={language.id ?? undefined}>
      <div className="code-block-bar">
        {language.label ? <span className="code-block-language">{language.label}</span> : <span />}
        <CopyCode value={source} label={copyLabel} copiedLabel={copiedLabel} />
      </div>
      <pre tabIndex={0}>
        <code className={className}>
          {tokens.map((token, index) =>
            token.type ? (
              <span className={`tok-${token.type}`} key={index}>
                {token.text}
              </span>
            ) : (
              token.text
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
