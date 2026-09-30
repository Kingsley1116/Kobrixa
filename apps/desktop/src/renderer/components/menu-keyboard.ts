import type { KeyboardEvent } from "react";

function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  return [...(root?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
}

export function focusFirstMenuItem(root: HTMLElement | null): void {
  menuItems(root)[0]?.focus();
}

/** Shared navigation; each menu retains its own positioning and dismissal target. */
export function handleMenuKey(
  event: KeyboardEvent,
  root: HTMLElement | null,
  dismiss: () => void,
): void {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = menuItems(root);
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(root?.ownerDocument.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : current < 0
          ? event.key === "ArrowDown"
            ? 0
            : items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}
