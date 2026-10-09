import { useState, type DragEvent, type KeyboardEvent } from "react";

/** Returns a copy with the item at `from` placed at final index `to`; out-of-range moves are no-ops. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length)
    return [...items];
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Final index for dropping `from` before (or after) the item at `target`. */
export function dropIndex(from: number, target: number, after: boolean): number {
  const index = after ? target + 1 : target;
  return from < index ? index - 1 : index;
}

/** Final index for Alt+Shift+Arrow/Home/End on the tab at `index`, or undefined for other keys. */
export function keyboardMoveIndex(
  event: Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">,
  index: number,
  count: number,
): number | undefined {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return undefined;
  const to =
    event.key === "ArrowLeft"
      ? index - 1
      : event.key === "ArrowRight"
        ? index + 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : undefined;
  return to === undefined ? undefined : Math.max(0, Math.min(count - 1, to));
}

/** Drag-and-drop plus Alt+Shift+Arrow reordering for one tab strip. Drops from other strips are ignored. */
export function useTabReorder({
  count,
  disabled,
  onMove,
}: {
  count: number;
  disabled: boolean;
  onMove(from: number, to: number): void;
}) {
  const [drag, setDrag] = useState<{ from: number; over?: number; after?: boolean }>();
  const clear = () => setDrag(undefined);
  const itemProps = (index: number) => ({
    draggable: !disabled,
    className:
      drag?.from === index
        ? "dragging"
        : drag?.over === index
          ? drag.after
            ? "drop-after"
            : "drop-before"
          : "",
    onDragStart(event: DragEvent<HTMLElement>) {
      if (disabled) return event.preventDefault();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", "");
      setDrag({ from: index });
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!drag) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = event.currentTarget.getBoundingClientRect();
      const after = event.clientX > box.left + box.width / 2;
      if (drag.over !== index || drag.after !== after) setDrag({ ...drag, over: index, after });
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!drag) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      const to = dropIndex(drag.from, index, event.clientX > box.left + box.width / 2);
      clear();
      if (!disabled && to !== drag.from) onMove(drag.from, to);
    },
    onDragEnd: clear,
  });
  /** Handles the reorder shortcut; returns the new index when the tab moved. */
  const keyDown = (index: number, event: KeyboardEvent): number | undefined => {
    const to = keyboardMoveIndex(event, index, count);
    if (to === undefined) return undefined;
    event.preventDefault();
    if (disabled || to === index) return undefined;
    onMove(index, to);
    return to;
  };
  return { itemProps, keyDown };
}
