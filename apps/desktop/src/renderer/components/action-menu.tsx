import { useEffect, useRef, useState, type ReactNode } from "react";

export function ActionMenu({
  label,
  visibleLabel,
  children,
}: {
  label: string;
  visibleLabel?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>("[role=menu] button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="action-menu"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = [
            ...(root.current?.querySelectorAll<HTMLButtonElement>(
              "[role=menu] button:not(:disabled)",
            ) ?? []),
          ];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="more-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {visibleLabel ?? "•••"}
      </button>
      {open && (
        <div
          className="action-menu-content"
          role="menu"
          aria-label={label}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
