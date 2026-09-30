/** Physical key codes keep bindings stable during IME input and across letter case. */
export type KeySequence = string[];
export interface KeyboardContext {
  editorFocused: boolean;
  capturing: boolean;
  chordPending: boolean;
  managedKeys: string[];
}
export const KEYBOARD_DEFAULT: KeyboardContext = {
  editorFocused: false,
  capturing: false,
  chordPending: false,
  managedKeys: [],
};
export function keyboardStroke(event: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string {
  return [
    event.ctrlKey && "Ctrl",
    event.metaKey && "Meta",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.code,
  ]
    .filter(Boolean)
    .join("+");
}
export function validStroke(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(Ctrl\+)?(Meta\+)?(Alt\+)?(Shift\+)?(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9])|Arrow(?:Up|Down|Left|Right)|Enter|Tab|Space|Backspace|Delete|Escape|Home|End|PageUp|PageDown|Insert|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Minus|Equal|Numpad[0-9]|Numpad(?:Add|Subtract|Multiply|Divide|Decimal|Enter))$/.test(
      value,
    )
  );
}
export function reservedStroke(stroke: string, mac: boolean): boolean {
  const reserved = mac
    ? [
        "Meta+KeyQ",
        "Meta+KeyH",
        "Meta+Alt+KeyH",
        "Meta+KeyM",
        "Meta+Space",
        "Ctrl+Meta+KeyQ",
        "Meta+Alt+Escape",
      ]
    : ["Ctrl+KeyQ", "Alt+F4", "Alt+Tab", "Ctrl+Alt+Delete"];
  return reserved.includes(stroke) || (!mac && stroke.includes("Meta+"));
}
export function ignoreMenuShortcut(context: KeyboardContext, stroke: string, mac = false): boolean {
  if (context.capturing) return true;
  if (reservedStroke(stroke, mac)) return false;
  return context.editorFocused || context.chordPending || context.managedKeys.includes(stroke);
}

export function sequencesOverlap(a: KeySequence, b: KeySequence): boolean {
  return (
    a.length > 0 &&
    b.length > 0 &&
    a.slice(0, Math.min(a.length, b.length)).every((key, i) => key === b[i])
  );
}
export function formatSequence(sequence: KeySequence, mac: boolean): string {
  return sequence
    .map((stroke) =>
      stroke
        .split("+")
        .map((key) => {
          if (key === "Meta") return mac ? "⌘" : "Win";
          if (key === "Ctrl") return mac ? "⌃" : "Ctrl";
          if (key === "Alt") return mac ? "⌥" : "Alt";
          if (key === "Shift") return mac ? "⇧" : "Shift";
          return (
            (
              {
                Comma: ",",
                Period: ".",
                Slash: "/",
                Backslash: "\\",
                BracketLeft: "[",
                BracketRight: "]",
                Semicolon: ";",
                Quote: "'",
                Backquote: "`",
                Minus: "-",
                Equal: "=",
                ArrowUp: "↑",
                ArrowDown: "↓",
                ArrowLeft: "←",
                ArrowRight: "→",
              } as Record<string, string>
            )[key] ?? key.replace(/^(Key|Digit)/, "")
          );
        })
        .join(mac ? "" : "+"),
    )
    .join(" → ");
}
