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
  tabProps,
  onKeyDown,
  closeContent = "×",
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
  /** Extra container handlers, e.g. drag-and-drop reordering or a context menu. */
  tabProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  onKeyDown?(event: KeyboardEvent<HTMLButtonElement>): void;
  /** Replaces the × glyph, e.g. with a pin for pinned tabs. */
  closeContent?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={`tab ${className} ${active ? "active" : ""}`.trim()} ref={ref} {...tabProps}>
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
        {closeContent}
      </button>
    </div>
  );
}
