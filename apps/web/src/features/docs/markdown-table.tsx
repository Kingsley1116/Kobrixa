import { useEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import "./styles/table.css";

type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & { node?: unknown };
type Overflow = { scrollable: boolean; atStart: boolean; atEnd: boolean };

const initialOverflow: Overflow = { scrollable: false, atStart: true, atEnd: true };

function scrollLabel() {
  const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
  return lang === "en" ? "Scrollable table" : "可水平捲動的表格";
}

/**
 * Wraps markdown tables in a bordered, horizontally scrollable container. When
 * the table is wider than the column, the container becomes keyboard
 * focusable and shows an edge shadow on the side that still has content.
 */
export function MarkdownTable({ node: _node, children, ...props }: MarkdownTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<Overflow>(initialOverflow);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      const next: Overflow = {
        scrollable: max > 1,
        atStart: element.scrollLeft <= 1,
        atEnd: element.scrollLeft >= max - 1,
      };
      setOverflow((current) =>
        current.scrollable === next.scrollable &&
        current.atStart === next.atStart &&
        current.atEnd === next.atEnd
          ? current
          : next,
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    const table = element.firstElementChild;
    if (table) observer?.observe(table);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  return (
    <div
      className="table-wrap"
      data-scrollable={overflow.scrollable || undefined}
      data-scroll-start={overflow.scrollable && !overflow.atStart ? "" : undefined}
      data-scroll-end={overflow.scrollable && !overflow.atEnd ? "" : undefined}
    >
      <div
        ref={scrollRef}
        className="table-scroll"
        {...(overflow.scrollable
          ? { tabIndex: 0, role: "region", "aria-label": scrollLabel() }
          : {})}
      >
        <table {...props}>{children}</table>
      </div>
    </div>
  );
}
