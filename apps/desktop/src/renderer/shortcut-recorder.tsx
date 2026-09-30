import { useEffect, useRef, useState, type ReactNode } from "react";
import type { KeyboardSettings } from "./keyboard-state.js";
import type { Locale } from "./copy.js";
import type { KeySequence } from "./keybindings.js";
import { ShortcutRecording, type RecordingState } from "./shortcut-recording.js";
import { ShortcutKeys } from "./shortcut-keys.js";

export function ShortcutRecorder({
  keyboard,
  locale,
  initialMode,
  initialKeys,
  onChange,
  onCancel,
  children,
}: {
  keyboard: KeyboardSettings;
  locale: Locale;
  initialMode: 1 | 2;
  initialKeys: KeySequence;
  onChange(state: RecordingState): void;
  onCancel(): void;
  children(state: RecordingState): ReactNode;
}) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const [state, setState] = useState<RecordingState>({
    mode: initialMode,
    keys: initialKeys,
    phase: initialKeys.length === initialMode ? "ready" : "idle",
  });
  const callbacks = useRef({ onChange, onCancel });
  callbacks.current = { onChange, onCancel };
  const [recorder] = useState(
    () =>
      new ShortcutRecording(initialMode, initialKeys, (next) => {
        setState(next);
        callbacks.current.onChange(next);
      }),
  );
  const start = useRef<HTMLButtonElement>(null);
  const output = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    start.current?.focus();
    return () => recorder.dispose();
  }, [recorder]);
  const active = state.phase === "recording";
  useEffect(() => {
    keyboard.setCapturing(active);
    if (!active) return () => keyboard.setCapturing(false);
    output.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.getModifierState("AltGraph")
      )
        return;
      if (event.key === "Escape") callbacks.current.onCancel();
      else {
        recorder.accept(event);
        if (recorder.state.phase === "ready") start.current?.focus();
      }
    };
    const interrupt = () => recorder.interrupt();
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", interrupt);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", interrupt);
      keyboard.setCapturing(false);
    };
  }, [active, keyboard.setCapturing, recorder]);
  useEffect(() => {
    if (state.phase === "expired") start.current?.focus();
  }, [state.phase]);
  return (
    <div className="shortcut-capture">
      <fieldset className="shortcut-mode">
        <legend>{t("按鍵組數", "Shortcut length")}</legend>
        {([1, 2] as const).map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name="shortcut-mode"
              checked={state.mode === mode}
              onChange={() => recorder.setMode(mode)}
            />
            {mode === 1 ? t("單組", "Single stroke") : t("兩段", "Two strokes")}
          </label>
        ))}
      </fieldset>
      <output
        ref={output}
        tabIndex={-1}
        className={`shortcut-record-output ${active ? "recording" : ""}`}
        aria-live="polite"
      >
        {state.keys.length > 0 ? (
          <ShortcutKeys keys={state.keys} mac={keyboard.mac} locale={locale} />
        ) : (
          t("尚未錄製按鍵", "No keys recorded")
        )}
        <span className="shortcut-record-progress">
          {active
            ? state.keys.length
              ? t(
                  "第一組已錄製，請在兩秒內按第二組…",
                  "First stroke recorded. Press the second within two seconds…",
                )
              : t("請按下第一組快捷鍵…", "Press the first shortcut…")
            : state.phase === "ready"
              ? t("錄製完成，可確認並套用。", "Recording complete. Review and apply.")
              : state.phase === "expired"
                ? t(
                    "錄製已逾時或中斷，請重新錄製。",
                    "Recording timed out or was interrupted. Record again.",
                  )
                : t("開始錄製後，Escape 可取消。", "Start recording; Escape cancels.")}
        </span>
      </output>
      <button
        ref={start}
        type="button"
        data-record-start
        onClick={() => (active ? recorder.interrupt() : recorder.start())}
      >
        {active
          ? t("停止錄製", "Stop recording")
          : state.phase === "idle"
            ? t("開始錄製", "Start recording")
            : t("重新錄製", "Record again")}
      </button>
      {children(state)}
    </div>
  );
}
