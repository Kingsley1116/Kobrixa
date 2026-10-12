import { useCallback, useEffect, useRef, useState } from "react";
import "./styles/toc.css";

export type TocHeading = { level: 2 | 3; text: string; id: string };

/** Heading ids must match the ids the markdown renderer assigns to `h2`/`h3`. */
export function toSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
}

/** Collect the `##`/`###` headings of a markdown document, skipping fenced code blocks. */
export function headingsFor(content: string): TocHeading[] {
  let fence: string | undefined;
  return content.split("\n").flatMap((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker)
        fence = undefined;
      return [];
    }
    if (fence) return [];
    const match = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!match) return [];
    const markers = match[1];
    const heading = match[2];
    if (!markers || !heading) return [];
    const text = heading.replace(/[`*_]/g, "");
    return [{ level: markers.length as 2 | 3, text, id: toSlug(text) }];
  });
}

/** A heading becomes current once it scrolls above this line (px from the viewport top). */
function activationLine(): number {
  const navbar = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--app-navbar-height"),
  );
  return (Number.isFinite(navbar) ? navbar : 72) + Math.min(window.innerHeight * 0.2, 200);
}

function isAtBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
}

/**
 * Track which heading the reader is currently in. IntersectionObserver reports headings crossing
 * the activation line below the sticky navbar; the active heading is the last one above it.
 */
function useActiveHeading(headings: TocHeading[]): [string | undefined, (id: string) => void] {
  const [active, setActive] = useState<string>();
  // A clicked entry wins at the end of the page, where its heading may never reach the line.
  const pinned = useRef<string | undefined>(undefined);
  const key = headings.map((heading) => heading.id).join("\n");
  useEffect(() => {
    setActive(undefined);
    const ids = key ? key.split("\n") : [];
    if (!ids.length || typeof IntersectionObserver === "undefined") return;
    let frame = 0;
    let observed: HTMLElement[] = [];
    let observer: IntersectionObserver | undefined;
    let wasAtBottom = false;
    // Markdown headings can be re-mounted when the article re-renders, so resolve them by id and
    // re-observe whenever the nodes have been replaced.
    const resolve = () => {
      const elements = ids
        .map((id) => document.getElementById(id))
        .filter((element): element is HTMLElement => element !== null);
      if (
        observer &&
        elements.length === observed.length &&
        elements.every((element, index) => element === observed[index])
      )
        return observed;
      observer?.disconnect();
      observer = new IntersectionObserver(schedule, {
        rootMargin: `-${Math.round(activationLine())}px 0px 0px 0px`,
        threshold: [0, 1],
      });
      for (const element of elements) observer.observe(element);
      observed = elements;
      return elements;
    };
    const update = () => {
      frame = 0;
      const line = activationLine();
      const atBottom = isAtBottom();
      wasAtBottom = atBottom;
      let current: string | undefined;
      let pinnedVisible = false;
      for (const element of resolve()) {
        const top = element.getBoundingClientRect().top;
        if (element.id === pinned.current && top < window.innerHeight) pinnedVisible = true;
        if (top <= line || (atBottom && top < window.innerHeight)) current = element.id;
        else break;
      }
      setActive(atBottom && pinnedVisible ? pinned.current : current);
    };
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    // Headings in a short final section never cross the line, so also catch the end of the page.
    const onScroll = () => {
      if (isAtBottom() || wasAtBottom || observed.some((element) => !element.isConnected))
        schedule();
    };
    // Manual scrolling releases a clicked entry.
    const release = () => {
      pinned.current = undefined;
    };
    // The activation line depends on the viewport height, so rebuild the observer on resize.
    const onResize = () => {
      observer?.disconnect();
      observer = undefined;
      schedule();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("hashchange", schedule);
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    window.addEventListener("keydown", release);
    resolve();
    schedule();
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("hashchange", schedule);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
      window.removeEventListener("keydown", release);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);
  const select = useCallback((id: string) => {
    pinned.current = id;
    setActive(id);
  }, []);
  return [active, select];
}

function TocList({
  headings,
  active,
  onSelect,
}: {
  headings: TocHeading[];
  active: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <ol className="toc-list">
      {headings.map((heading, index) => (
        <li
          className={heading.level === 3 ? "toc-item nested" : "toc-item"}
          key={`${index}-${heading.id}`}
        >
          <a
            href={`#${heading.id}`}
            aria-current={heading.id === active ? "location" : undefined}
            onClick={() => onSelect(heading.id)}
          >
            {heading.text}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** Sticky "On this page" rail shown beside the article on wide screens. */
export function DocsToc({
  headings,
  label,
  className = "toc",
}: {
  headings: TocHeading[];
  label: string;
  className?: string;
}) {
  const [active, setActive] = useActiveHeading(headings);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside || !active || aside.scrollHeight <= aside.clientHeight) return;
    const link = aside.querySelector<HTMLElement>('a[aria-current="location"]');
    if (!link) return;
    // The sticky aside is the link's offsetParent, so offsetTop is relative to it.
    const top = link.offsetTop;
    if (top < aside.scrollTop + 32 || top > aside.scrollTop + aside.clientHeight - 48)
      aside.scrollTop = Math.max(0, top - aside.clientHeight / 3);
  }, [active]);
  if (!headings.length) return null;
  return (
    <aside className={className} aria-label={label} ref={asideRef}>
      <p>{label}</p>
      <TocList headings={headings} active={active} onSelect={setActive} />
    </aside>
  );
}

/** Collapsible "On this page" list placed at the top of the article on narrow screens. */
export function DocsTocDisclosure({ headings, label }: { headings: TocHeading[]; label: string }) {
  const [active, setActive] = useActiveHeading(headings);
  if (!headings.length) return null;
  return (
    <details className="toc-disclosure">
      <summary>
        <span>{label}</span>
        <small>{headings.filter((heading) => heading.level === 2).length || headings.length}</small>
      </summary>
      <nav aria-label={label}>
        <TocList headings={headings} active={active} onSelect={setActive} />
      </nav>
    </details>
  );
}
