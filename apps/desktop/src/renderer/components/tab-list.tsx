import { useRef, type CSSProperties } from "react";

interface TabOption<T extends string> {
  value: T;
  label: string;
  id: string;
  panelId: string;
}

/** Automatically activated tabs with one keyboard stop and focus scoped to this list. */
export function TabList<T extends string>({
  tabs,
  value,
  onChange,
  label,
  variant = "primary",
  className = "",
}: {
  tabs: readonly TabOption<T>[];
  value: T;
  onChange(value: T): void;
  label: string;
  variant?: "primary" | "compact";
  className?: string;
}): React.JSX.Element {
  const bar = useRef<HTMLDivElement>(null);
  return (
    <div
      className={`tab-list tab-list-${variant} ${className}`}
      role="tablist"
      aria-label={label}
      data-active-tab={value}
      style={
        {
          "--tab-count": tabs.length,
          "--tab-index": Math.max(
            0,
            tabs.findIndex((tab) => tab.value === value),
          ),
        } as CSSProperties
      }
      ref={bar}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.value}
          type="button"
          id={tab.id}
          role="tab"
          title={tab.label}
          aria-selected={value === tab.value}
          aria-controls={tab.panelId}
          tabIndex={value === tab.value ? 0 : -1}
          onClick={() => onChange(tab.value)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
            onChange(tabs[next]!.value);
            bar.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
