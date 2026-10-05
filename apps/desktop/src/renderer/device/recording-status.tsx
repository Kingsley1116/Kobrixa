import { useState, useSyncExternalStore } from "react";
import { Icon } from "../components/icon.js";
import type { Locale } from "../i18n/copy.js";
import type { SensorLabController } from "./sensor-lab-controller.js";

/** Its subscription stays outside App so sampling never rerenders the editor shell. */
export function RecordingStatus({
  controller,
  locale,
  onOpen,
}: {
  controller: SensorLabController;
  locale: Locale;
  onOpen(): void;
}): React.JSX.Element | null {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [dismissed, setDismissed] = useState<string>();
  const zh = locale === "zh-TW";
  const { lab } = state;
  const unexpected =
    !!lab.recording?.reason && lab.recording.reason !== "manual" && dismissed !== lab.recording.id;
  if (!lab.active && lab.saved && !lab.error && !unexpected) return null;
  const seconds = Math.max(0, Math.floor((lab.recording?.durationMs ?? 0) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const label = lab.active
    ? lab.waiting
      ? zh
        ? "記錄中 · 等待讀值"
        : "Recording · waiting"
      : zh
        ? "記錄中"
        : "Recording"
    : !lab.saved
      ? zh
        ? "記錄尚未儲存"
        : "Recording not saved"
      : zh
        ? "記錄已停止"
        : "Recording stopped";
  return (
    <div
      className="sensor-recording-status"
      data-testid="sensor-recording-status"
      data-warning={!!lab.error || lab.waiting || !lab.active}
    >
      <button
        title={`${label} ${elapsed}`}
        onClick={() => {
          setDismissed(lab.recording?.id);
          onOpen();
        }}
      >
        <span aria-hidden="true">{lab.active ? "●" : "!"}</span>
        <span>{label}</span>
        <time>{elapsed}</time>
      </button>
      {lab.active && (
        <button
          className="sensor-recording-stop"
          disabled={state.busy}
          title={zh ? "停止記錄" : "Stop recording"}
          aria-label={zh ? "停止記錄" : "Stop recording"}
          onClick={() => void controller.stop()}
        >
          <Icon name="stop" />
        </button>
      )}
    </div>
  );
}
