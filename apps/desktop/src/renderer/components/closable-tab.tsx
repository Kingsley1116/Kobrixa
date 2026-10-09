import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";

export function ClosableTab({
  children,
  active,
  onSelect,
  onClose,
  closeLabel,
  closeTitle = closeLabel,
  closeDisabled,
  title,
  controls,
  className = "",
  ref,
  dragProps,
  onKeyDown,
}: {
  children: ReactNode;
  active: boolean;
  onSelect(): void;
  onClose(): void;
  closeLabel: string;
  closeTitle?: string;
  closeDisabled?: boolean;
  title?: string;
  controls?: string;
  className?: string;
  ref?: Ref<HTMLDivElement> | undefined;
  /** Drag-and-drop handlers for reorderable tab strips. */
  dragProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  onKeyDown?(event: KeyboardEvent<HTMLButtonElement>): void;
}): React.JSX.Element {
  return (
    <div className={`tab ${className} ${active ? "active" : ""}`.trim()} ref={ref} {...dragProps}>
      <button
        type="button"
        className="tab-select"
        role="tab"
        aria-selected={active}
        aria-controls={controls}
        title={title}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        {children}
      </button>
      <button
        type="button"
        className="tab-close"
        disabled={closeDisabled}
        aria-label={closeLabel}
        title={closeTitle}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
