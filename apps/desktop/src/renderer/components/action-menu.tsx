import { useEffect, useRef, useState, type ReactNode } from "react";
import { focusFirstMenuItem, handleMenuKey } from "./menu-keyboard.js";

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
    focusFirstMenuItem(root.current);
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
        if (!open) return;
        handleMenuKey(event, root.current, () => {
          setOpen(false);
          trigger.current?.focus();
        });
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
