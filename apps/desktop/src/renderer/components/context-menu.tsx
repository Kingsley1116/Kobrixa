import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { focusFirstMenuItem, handleMenuKey } from "./menu-keyboard.js";

/** A pointer-positioned menu that dismisses on outside pointer, window blur or Escape. */
export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label: string;
  onClose(): void;
  children: ReactNode;
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    // Keep the whole menu on screen when opened near the right or bottom edge.
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [x, y]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dismiss = () => close.current();
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    window.requestAnimationFrame(() => focusFirstMenuItem(root.current));
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, []);
  return (
    <div
      className="tree-context-menu"
      ref={root}
      role="menu"
      aria-label={label}
      style={position}
      onKeyDown={(event) => handleMenuKey(event, root.current, () => close.current())}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button:not(:disabled)")) onClose();
      }}
    >
      {children}
    </div>
  );
}
