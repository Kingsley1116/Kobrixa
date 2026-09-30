import type { ReactNode, Ref } from "react";

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
}): React.JSX.Element {
  return (
    <div className={`tab ${className} ${active ? "active" : ""}`.trim()} ref={ref}>
      <button
        type="button"
        className="tab-select"
        role="tab"
        aria-selected={active}
        aria-controls={controls}
        title={title}
        onClick={onSelect}
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
