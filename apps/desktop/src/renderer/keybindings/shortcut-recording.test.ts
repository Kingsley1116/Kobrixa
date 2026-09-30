import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutRecording } from "./shortcut-recording.js";
const key = (code: string, extra = {}) => ({
  code,
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 0,
  getModifierState: () => false,
  ...extra,
});
afterEach(() => vi.useRealTimers());
describe("shortcut recorder", () => {
  it("finishes a single stroke immediately and ignores subsequent keys", () => {
    const recorder = new ShortcutRecording(1, [], vi.fn());
    recorder.start();
    recorder.accept(key("KeyS"));
    recorder.accept(key("KeyK"));
    expect(recorder.state).toEqual({ mode: 1, keys: ["Ctrl+KeyS"], phase: "ready" });
  });
  it("requires both strokes within two seconds and never downgrades an incomplete chord", () => {
    vi.useFakeTimers();
    const recorder = new ShortcutRecording(2, [], vi.fn());
    recorder.start();
    recorder.accept(key("KeyK"));
    vi.advanceTimersByTime(1999);
    expect(recorder.state.phase).toBe("recording");
    vi.advanceTimersByTime(1);
    expect(recorder.state).toEqual({ mode: 2, keys: ["Ctrl+KeyK"], phase: "expired" });
    recorder.accept(key("KeyS"));
    expect(recorder.state.phase).toBe("expired");
    recorder.start();
    recorder.accept(key("KeyK"));
    recorder.accept(key("KeyS"));
    vi.advanceTimersByTime(3000);
    expect(recorder.state).toEqual({ mode: 2, keys: ["Ctrl+KeyK", "Ctrl+KeyS"], phase: "ready" });
  });
  it("ignores repeated keys, IME, AltGraph and standalone modifiers", () => {
    const recorder = new ShortcutRecording(1, [], vi.fn());
    recorder.start();
    for (const event of [
      key("KeyS", { repeat: true }),
      key("KeyS", { isComposing: true }),
      key("KeyS", { keyCode: 229 }),
      key("KeyS", { getModifierState: () => true }),
      key("ControlLeft"),
    ])
      recorder.accept(event);
    expect(recorder.state.keys).toEqual([]);
  });
  it("cleans up timers on mode change, interruption and disposal", () => {
    vi.useFakeTimers();
    const recorder = new ShortcutRecording(2, [], vi.fn());
    recorder.start();
    recorder.accept(key("KeyK"));
    recorder.setMode(1);
    vi.advanceTimersByTime(3000);
    expect(recorder.state).toEqual({ mode: 1, keys: [], phase: "idle" });
    recorder.start();
    recorder.interrupt();
    expect(recorder.state.phase).toBe("expired");
    recorder.setMode(2);
    recorder.start();
    recorder.accept(key("KeyK"));
    recorder.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("restores a completed candidate when returning from conflict editing", () => {
    const recorder = new ShortcutRecording(2, ["Ctrl+KeyK", "Ctrl+KeyS"], vi.fn());
    expect(recorder.state.phase).toBe("ready");
  });
});
