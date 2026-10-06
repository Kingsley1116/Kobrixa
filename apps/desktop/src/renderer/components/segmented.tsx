import { useRef } from "react";

interface SegmentOption<T> {
  value: T;
  label: string;
}

/** A radio group drawn as connected buttons, with one keyboard stop like native radios. */
export function Segmented<T extends string | number>({
  id,
  options,
  value,
  onChange,
  labelledBy,
  disabled = false,
}: {
  id?: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  labelledBy?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const group = useRef<HTMLDivElement>(null);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <div
      id={id}
      className="segmented"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      ref={group}
    >
      {options.map((option, index) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === selected ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? options.length - 1
                  : (index +
                      (event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : options.length - 1)) %
                    options.length;
            onChange(options[next]!.value);
            group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
