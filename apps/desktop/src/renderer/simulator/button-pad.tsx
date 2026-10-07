import type { PreviewButton } from "../../preview/virtual-device.js";
import type { SimulatorCopy } from "./simulator-copy.js";

const pad: PreviewButton[] = ["up", "left", "enter", "right", "down", "back"];
const glyphs: Record<PreviewButton, string> = {
  up: "▲",
  left: "◀",
  enter: "●",
  right: "▶",
  down: "▼",
  back: "↶",
};
const keys: Record<string, PreviewButton> = {
  ArrowUp: "up",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "down",
  Backspace: "back",
};
const buttonForKey = (event: React.KeyboardEvent) =>
  keys[event.key] ??
  (event.key === " " || event.key === "Enter"
    ? ((event.target as HTMLElement).dataset.simButton as PreviewButton | undefined)
    : undefined);

/** EV3 brick buttons; holds are tracked by the workspace so focus loss can release them. */
export function ButtonPad({
  t,
  held,
  disabled,
  onPress,
  onRelease,
}: {
  t: SimulatorCopy;
  held: readonly PreviewButton[];
  disabled: boolean;
  onPress(button: PreviewButton, down: boolean): void;
  onRelease(): void;
}): React.JSX.Element {
  return (
    <div
      className="sim-button-pad"
      role="group"
      aria-label={t.buttons}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onRelease();
      }}
      onKeyDown={(event) => {
        const name = buttonForKey(event);
        if (!name) return;
        event.preventDefault();
        if (!event.repeat) onPress(name, true);
      }}
      onKeyUp={(event) => {
        const name = buttonForKey(event);
        if (!name) return;
        event.preventDefault();
        onPress(name, false);
      }}
    >
      {pad.map((name) => (
        <button
          key={name}
          type="button"
          aria-label={t[name]}
          aria-pressed={held.includes(name)}
          data-sim-button={name}
          disabled={disabled}
          onBlur={onRelease}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onPress(name, true);
          }}
          onPointerUp={() => onPress(name, false)}
          onPointerCancel={onRelease}
          onLostPointerCapture={() => onPress(name, false)}
        >
          {glyphs[name]}
        </button>
      ))}
    </div>
  );
}
