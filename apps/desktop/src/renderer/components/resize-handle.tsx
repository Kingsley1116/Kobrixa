import { useEffect, useRef } from "react";

export function ResizeHandle({
  axis,
  direction = 1,
  value,
  min,
  max,
  defaultValue,
  onChange,
  label,
  visible,
  className = "",
}: {
  axis: "x" | "y";
  direction?: 1 | -1;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange(value: number): void;
  label: string;
  visible: boolean;
  className?: string;
}): React.JSX.Element {
  const finishDrag = useRef<(() => void) | undefined>(undefined);
  const change = useRef(onChange);
  change.current = onChange;
  const constrain = (next: number) => Math.max(min, Math.min(max, next));
  useEffect(() => {
    if (!visible) finishDrag.current?.();
    return () => finishDrag.current?.();
  }, [visible]);
  return (
    <div
      className={`resize-handle ${className}`.trim()}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onDoubleClick={() => {
        if (visible) onChange(constrain(defaultValue));
      }}
      onKeyDown={(event) => {
        if (!visible || event.nativeEvent.isComposing) return;
        const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
        const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
        if (event.key !== negative && event.key !== positive) return;
        event.preventDefault();
        onChange(constrain(value + (event.key === positive ? 16 : -16) * direction));
      }}
      onPointerDown={(event) => {
        if (!visible || event.button !== 0) return;
        finishDrag.current?.();
        event.currentTarget.focus();
        event.preventDefault();
        const start = axis === "x" ? event.clientX : event.clientY;
        const pointerId = event.pointerId;
        const bodyClass = axis === "x" ? "is-resizing-horizontal" : "is-resizing-vertical";
        document.body.classList.add(bodyClass);
        const move = (pointer: PointerEvent) => {
          if (pointer.pointerId !== pointerId) return;
          const position = axis === "x" ? pointer.clientX : pointer.clientY;
          change.current(constrain(value + (position - start) * direction));
        };
        const finish = () => {
          document.body.classList.remove(bodyClass);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", release);
          window.removeEventListener("blur", finish);
          finishDrag.current = undefined;
        };
        const release = (pointer: PointerEvent) => {
          if (pointer.pointerId === pointerId) finish();
        };
        finishDrag.current = finish;
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
        window.addEventListener("blur", finish);
      }}
    />
  );
}
