export interface SelectionOption<T> {
  value: T;
  disabled?: boolean;
}

/** Range and select-all add visible items without losing filtered selections. */
export function updateSelection<T>(
  options: readonly SelectionOption<T>[],
  selected: readonly T[],
  value: T,
  mode: "single" | "toggle" | "range",
  anchor?: T,
): T[] {
  const index = options.findIndex((option) => option.value === value && !option.disabled);
  if (index < 0) return [...selected];
  if (mode === "single") return [value];
  if (mode === "toggle")
    return selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];
  const origin = options.findIndex((option) => option.value === anchor);
  const from = origin < 0 ? index : origin;
  return [
    ...new Set([
      ...selected,
      ...options
        .slice(Math.min(from, index), Math.max(from, index) + 1)
        .filter((option) => !option.disabled)
        .map((option) => option.value),
    ]),
  ];
}

export function selectVisible<T>(
  options: readonly SelectionOption<T>[],
  selected: readonly T[],
  checked: boolean,
): T[] {
  const visible = options.filter((option) => !option.disabled).map((option) => option.value);
  return checked
    ? [...new Set([...selected, ...visible])]
    : selected.filter((value) => !visible.includes(value));
}
