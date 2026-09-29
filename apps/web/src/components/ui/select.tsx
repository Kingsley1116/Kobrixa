import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type SelectOption = { value: string; label: string };
export function Select({
  value,
  options,
  onValueChange,
  label,
  disabled = false,
}: {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const open = expanded && !disabled && options.length > 0;
  const activeIndex = Math.min(active, options.length - 1);
  function show(index = selected) {
    search.current = { text: "", time: 0 };
    setActive(index);
    setExpanded(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (option && option.value !== value) onValueChange(option.value);
    setExpanded(false);
  }
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const below = window.innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const upwards = below < 240 && above > below;
      const height = Math.min(320, Math.max(44, upwards ? above : below));
      const width = Math.min(Math.max(bounds.width, 200), window.innerWidth - 24);
      setPosition({
        position: "fixed",
        width,
        maxHeight: height,
        left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
        ...(upwards ? { bottom: window.innerHeight - bounds.top + 6 } : { top: bounds.bottom + 6 }),
      });
    }
    place();
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const list = popup.current;
    const option = list?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!list || !option) return;
    const item = option.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    // Scroll only the popup; scrollIntoView would also move the page behind it.
    if (item.top < bounds.top + 5) list.scrollTop -= bounds.top + 5 - item.top;
    else if (item.bottom > bounds.bottom - 5) list.scrollTop += item.bottom - bounds.bottom + 5;
  }, [open, activeIndex, position]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        setExpanded(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function keydown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab") {
      if (open) choose(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
      }
      return;
    }
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (open) choose(activeIndex);
      else show();
      return;
    }
    const moves: Record<string, number> = {
      ArrowDown: open ? Math.min(options.length - 1, activeIndex + 1) : selected,
      ArrowUp: open ? Math.max(0, activeIndex - 1) : selected,
      Home: 0,
      End: options.length - 1,
      PageDown: Math.min(options.length - 1, activeIndex + 10),
      PageUp: Math.max(0, activeIndex - 10),
    };
    if (event.key in moves) {
      event.preventDefault();
      if (open && event.altKey && event.key === "ArrowUp") choose(activeIndex);
      else show(moves[event.key]);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const text =
        (now - search.current.time < 700 ? search.current.text : "") +
        event.key.toLocaleLowerCase();
      search.current = { text, time: now };
      const repeated = [...text].every((char) => char === text[0]);
      const prefix = repeated ? text[0]! : text;
      const start = open ? activeIndex : selected;
      for (let offset = repeated ? 1 : 0; offset <= options.length; offset++) {
        const index = (start + offset) % options.length;
        if (options[index]?.label.toLocaleLowerCase().startsWith(prefix)) {
          setActive(index);
          break;
        }
      }
      setExpanded(true);
    }
  }
  return (
    <div className="ui-select">
      <button
        ref={trigger}
        type="button"
        className="ui-select-trigger"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${activeIndex}` : undefined}
        disabled={disabled || !options.length}
        onKeyDown={keydown}
        onBlur={() => setExpanded(false)}
        onClick={() => (open ? setExpanded(false) : show())}
      >
        <span>{options[selected]?.label ?? label}</span>
        <span className="ui-chevron" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            role="listbox"
            aria-label={label}
            className="ui-select-popup"
            style={position}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-${index}`}
                role="option"
                aria-selected={option.value === value}
                data-index={index}
                data-active={index === activeIndex}
                className="ui-select-option"
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => {
                  choose(index);
                  trigger.current?.focus();
                }}
              >
                <span>{option.label}</span>
                <span aria-hidden="true">{option.value === value ? "✓" : ""}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
