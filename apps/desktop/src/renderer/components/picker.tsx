import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Locale } from "../i18n/copy.js";
import { selectVisible, updateSelection } from "./selection.js";
import { focusableElements } from "./modal.js";
import { Icon } from "./icon.js";

export interface PickerOption<T extends string | number> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  action?: { label: string; run(): void };
}
type Selection<T> =
  | { multiple?: false; value: T | undefined; onChange(value: T): void }
  | { multiple: true; value: T[]; onChange(value: T[]): void };
type PickerProps<T extends string | number> = Selection<T> & {
  options: PickerOption<T>[];
  label: string;
  locale: Locale;
  id?: string;
  describedBy?: string;
  disabled?: boolean;
  searchable?: boolean;
  presentation?: "dropdown" | "list";
  triggerContent?: ReactNode;
  empty?: ReactNode;
  listRef?: RefObject<HTMLDivElement | null>;
};

export function Picker<T extends string | number>(props: PickerProps<T>): React.JSX.Element {
  const { options, label, locale, disabled, searchable, presentation = "dropdown" } = props;
  const id = useId();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const [focused, setFocused] = useState<T>(),
    [anchor, setAnchor] = useState<T>();
  const [position, setPosition] = useState<CSSProperties>({ position: "fixed" });
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const ownList = useRef<HTMLDivElement>(null),
    list = props.listRef ?? ownList;
  const typeahead = useRef({ text: "", time: 0 });
  const previousOptions = useRef(options);
  const listHadFocus = useRef(false);
  const selected: readonly T[] = props.multiple
    ? props.value
    : props.value === undefined
      ? []
      : [props.value];
  const visible = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const navigable = visible.filter(
    (option) => !option.disabled || (presentation === "list" && option.action),
  );
  const active =
    navigable.find((option) => option.value === focused) ??
    navigable.find((option) => selected.includes(option.value)) ??
    navigable[0];
  const zh = locale === "zh-TW";
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const select = (value: T, range = false) => {
    if (disabled || !visible.some((option) => option.value === value && !option.disabled)) return;
    const next = updateSelection(
      visible,
      selected,
      value,
      props.multiple ? (range ? "range" : "toggle") : "single",
      anchor,
    );
    if (props.multiple) props.onChange(next);
    else if (next[0] !== undefined) {
      props.onChange(next[0]);
      if (presentation === "dropdown") close();
    }
    if (!range) setAnchor(value);
  };
  const focus = (value: T) => {
    setFocused(value);
    [...(list.current?.querySelectorAll<HTMLElement>("[data-picker-value]") ?? [])]
      .find((element) => element.dataset.pickerValue === String(value))
      ?.focus();
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (focused !== undefined && !options.some((option) => option.value === focused)) {
      const index = previousOptions.current.findIndex((option) => option.value === focused);
      const next = options[Math.max(0, Math.min(index, options.length - 1))];
      setFocused(next?.value);
      setAnchor(undefined);
      if (next && listHadFocus.current && document.activeElement === document.body)
        focus(next.value);
    }
    previousOptions.current = options;
  });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12,
        above = rect.top - 12;
      const flip = below < 260 && above > below;
      setPosition({
        position: "fixed",
        width,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        maxHeight: Math.max(60, Math.min(360, flip ? above - 6 : below - 6)),
        ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    };
    place();
    const target = searchable
      ? popup.current?.querySelector<HTMLInputElement>("input")
      : list.current?.querySelector<HTMLElement>('[tabindex="0"]');
    target?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, searchable, list]);
  const content = (
    <div
      className={`picker-list ${presentation === "list" ? "picker-inline" : ""}`}
      ref={list}
      id={`${id}-list`}
      role={presentation === "dropdown" ? "listbox" : "group"}
      aria-label={label}
      aria-multiselectable={presentation === "dropdown" && props.multiple ? true : undefined}
      aria-disabled={disabled || undefined}
      onFocus={() => {
        listHadFocus.current = true;
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
          listHadFocus.current = false;
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.target instanceof HTMLButtonElement && ["Enter", " "].includes(event.key)) return;
        const index = navigable.findIndex((option) => option.value === active?.value);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? navigable.length - 1
                : Math.max(
                    0,
                    Math.min(navigable.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                  );
          const option = navigable[next];
          if (option) {
            focus(option.value);
            if (event.shiftKey && props.multiple) {
              const origin = anchor ?? active?.value;
              setAnchor(origin);
              props.onChange(updateSelection(visible, selected, option.value, "range", origin));
            }
          }
        } else if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "a" &&
          props.multiple
        ) {
          event.preventDefault();
          props.onChange(selectVisible(visible, selected, true));
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (presentation === "dropdown") close();
          else if (props.multiple) props.onChange([]);
        } else if (active && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          if (event.key === "Enter" && presentation === "list" && active.action)
            active.action.run();
          else select(active.value, event.shiftKey);
        } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
          const now = Date.now();
          typeahead.current = {
            text:
              (now - typeahead.current.time < 700 ? typeahead.current.text : "") +
              event.key.toLocaleLowerCase(),
            time: now,
          };
          const target = navigable.find((option) =>
            option.label.toLocaleLowerCase().startsWith(typeahead.current.text),
          );
          if (target) {
            event.preventDefault();
            focus(target.value);
          }
        }
      }}
    >
      {!visible.length &&
        (props.empty ?? (
          <p className="picker-empty">{zh ? "沒有符合的項目" : "No matching items"}</p>
        ))}
      {visible.map((option) => {
        const checked = selected.includes(option.value);
        return (
          <div
            key={option.value}
            className={`picker-option ${checked ? "selected" : ""}`}
            role={presentation === "dropdown" ? "option" : "group"}
            aria-label={option.label}
            aria-selected={presentation === "dropdown" ? checked : undefined}
            aria-disabled={option.disabled || disabled || undefined}
            data-picker-value={option.value}
            tabIndex={!disabled && active?.value === option.value ? 0 : -1}
            title={option.title ?? option.label}
            onFocus={() => setFocused(option.value)}
            onClick={(event) => {
              event.currentTarget.focus();
              select(option.value, event.shiftKey);
            }}
          >
            {presentation === "list" && props.multiple ? (
              <input
                type="checkbox"
                tabIndex={-1}
                checked={checked}
                disabled={disabled || option.disabled}
                aria-label={`${zh ? "選取" : "Select"} ${option.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  focus(option.value);
                  select(option.value, event.shiftKey);
                }}
                onChange={() => {}}
              />
            ) : (
              <span className="picker-check" aria-hidden="true">
                {checked ? "✓" : ""}
              </span>
            )}
            {option.icon}
            <span className="picker-option-label">
              <strong>{option.label}</strong>
              {option.description && <small>{option.description}</small>}
            </span>
            {presentation === "list" && option.action && (
              <button
                type="button"
                className="picker-open"
                disabled={disabled}
                aria-label={`${option.action.label} ${option.label}`}
                title={`${option.action.label} ${option.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  option.action!.run();
                }}
              >
                ↗
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
  if (presentation === "list") return content;
  return (
    <div
      className="picker"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        className={`picker-trigger ${props.triggerContent ? "picker-icon-trigger" : ""}`}
        id={props.id}
        ref={trigger}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-describedby={props.describedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            setQuery("");
            setFocused(
              event.key === "End" || event.key === "ArrowUp"
                ? navigable.at(-1)?.value
                : event.key === "Home"
                  ? navigable[0]?.value
                  : active?.value,
            );
            setOpen(true);
          }
        }}
      >
        {props.triggerContent ?? (
          <>
            <span>
              {props.multiple
                ? `${selected.length} ${zh ? "項已選取" : "selected"}`
                : (options.find((option) => option.value === props.value)?.label ?? label)}
            </span>
            <Icon name="chevron-down" />
          </>
        )}
      </button>
      {open &&
        createPortal(
          <div
            className="picker-popup"
            ref={popup}
            style={position}
            onKeyDown={(event) => {
              if (event.key !== "Tab" || !trigger.current) return;
              event.preventDefault();
              event.stopPropagation();
              const scope = trigger.current.closest<HTMLElement>(".modal-host") ?? document.body;
              const elements = focusableElements(scope).filter(
                (element) => !element.closest(".picker-popup"),
              );
              const index = elements.indexOf(trigger.current);
              const next = (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
              setOpen(false);
              (elements[next] ?? trigger.current).focus();
            }}
            onBlur={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget as Node) &&
                event.relatedTarget !== trigger.current
              )
                setOpen(false);
            }}
          >
            {searchable && (
              <input
                className="picker-search"
                type="search"
                aria-label={zh ? "搜尋選項" : "Search options"}
                placeholder={zh ? "搜尋選項…" : "Search options…"}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (active) select(active.value);
                  }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    if (active) focus(active.value);
                  }
                }}
              />
            )}
            {content}
          </div>,
          trigger.current?.closest(".modal-host") ?? document.body,
        )}
    </div>
  );
}
