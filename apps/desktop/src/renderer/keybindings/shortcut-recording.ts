import { keyboardStroke, validStroke, type KeySequence } from "../../shared/keyboard.js";
export interface RecordingState {
  mode: 1 | 2;
  keys: KeySequence;
  phase: "idle" | "recording" | "ready" | "expired";
}
/** One shared recorder for assignment and search. A timed-out chord is never a single binding. */
export class ShortcutRecording {
  private timer: ReturnType<typeof setTimeout> | undefined;
  state: RecordingState;
  constructor(
    mode: 1 | 2,
    keys: KeySequence,
    private changed: (state: RecordingState) => void,
  ) {
    this.state = { mode, keys, phase: keys.length === mode ? "ready" : "idle" };
  }
  private emit(state: RecordingState): void {
    this.state = state;
    this.changed(state);
  }
  start(): void {
    this.dispose();
    this.emit({ ...this.state, keys: [], phase: "recording" });
  }
  setMode(mode: 1 | 2): void {
    this.dispose();
    this.emit({ mode, keys: [], phase: "idle" });
  }
  accept(
    event: Pick<
      KeyboardEvent,
      | "code"
      | "ctrlKey"
      | "metaKey"
      | "altKey"
      | "shiftKey"
      | "repeat"
      | "isComposing"
      | "keyCode"
      | "getModifierState"
    >,
  ): void {
    if (
      this.state.phase !== "recording" ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.getModifierState("AltGraph")
    )
      return;
    const stroke = keyboardStroke(event);
    if (!validStroke(stroke)) return;
    const keys = [...this.state.keys, stroke];
    this.dispose();
    this.emit({
      ...this.state,
      keys,
      phase: keys.length === this.state.mode ? "ready" : "recording",
    });
    if (this.state.phase === "recording") this.timer = setTimeout(() => this.interrupt(), 2000);
  }
  interrupt(): void {
    this.dispose();
    if (this.state.phase === "recording") this.emit({ ...this.state, phase: "expired" });
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
