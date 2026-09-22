import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const scopes: HTMLElement[] = [];
const previousInert = new Map<HTMLElement, boolean>();
export const isModalOpen = (): boolean => scopes.length > 0;

function syncBackground(): void {
  for (const element of document.body.children) {
    if (!(element instanceof HTMLElement)) continue;
    if (!previousInert.has(element)) previousInert.set(element, element.inert);
    element.inert = scopes.length ? element !== scopes.at(-1) : previousInert.get(element)!;
  }
  if (!scopes.length) previousInert.clear();
}

export function canFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  return (
    !!element?.isConnected &&
    !element.closest("[inert], [hidden]") &&
    !element.matches(":disabled") &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], summary, [tabindex]",
    ),
  ].filter((element) => element.tabIndex >= 0 && canFocus(element));
}

export function Modal({
  children,
  onClose,
  restoreFocus = true,
  fallbackFocus,
}: {
  children: ReactNode;
  onClose(): void;
  restoreFocus?: boolean;
  fallbackFocus?(): void;
}): React.JSX.Element {
  const [host] = useState(() => document.createElement("div"));
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const fallback = useRef(fallbackFocus);
  close.current = onClose;
  fallback.current = fallbackFocus;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    host.className = "modal-host";
    document.body.append(host);
    scopes.push(host);
    syncBackground();
    const initial = () => {
      const preferred = host.querySelector<HTMLElement>("[data-modal-initial], [autofocus]");
      (canFocus(preferred) ? preferred : (focusableElements(host)[0] ?? root.current))?.focus();
    };
    if (!host.contains(document.activeElement)) initial();
    const contain = (event: FocusEvent) => {
      if (scopes.at(-1) === host && !host.contains(event.target as Node)) initial();
    };
    document.addEventListener("focusin", contain);
    return () => {
      document.removeEventListener("focusin", contain);
      scopes.splice(scopes.indexOf(host), 1);
      host.remove();
      syncBackground();
      if (restoreFocus) {
        if (previous !== document.body && canFocus(previous)) previous.focus();
        else fallback.current?.();
      }
    };
  }, [host, restoreFocus]);
  return createPortal(
    <div
      className="modal-backdrop"
      ref={root}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (scopes.at(-1) !== host || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close.current();
        } else if (event.key === "Tab") {
          const elements = focusableElements(host);
          const first = elements[0],
            last = elements.at(-1);
          if (!first) {
            event.preventDefault();
            root.current?.focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      {children}
    </div>,
    host,
  );
}
