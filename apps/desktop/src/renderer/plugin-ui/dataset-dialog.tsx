import { useLayoutEffect, useRef, type ReactNode } from "react";
/** One modal per panel; native modal focus isolation plus explicit keyboard wrap. */
export function DatasetDialog({
  label,
  children,
  closeLabel,
  onClose,
}: {
  label: string;
  children: ReactNode;
  closeLabel: string;
  onClose(): void;
}) {
  const root = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const dialog = root.current!;
    const previous = document.activeElement;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog
      .querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']",
      )
      ?.focus();
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="plugin-dataset-dialog"
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close.current();
          return;
        }
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, a[href], [tabindex]",
          ),
        ].filter((el) => !el.matches(":disabled") && el.tabIndex >= 0 && !el.closest("[hidden]"));
        const first = controls[0],
          last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header>
        <h3>{label}</h3>
        <button type="button" onClick={onClose}>
          {closeLabel}
        </button>
      </header>
      {children}
    </dialog>
  );
}
