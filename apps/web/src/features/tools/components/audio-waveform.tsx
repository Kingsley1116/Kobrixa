import { Icon } from "../../../components/ui/icon.js";
import { useMemo, useRef, useState } from "react";
import { MAX_DURATION, MAX_SAMPLES, SAMPLE_RATE } from "../lib/media.js";
import { clamp, waveformPeaks } from "../lib/media-processing.js";
import type { AudioSettings } from "../lib/media-processing.js";
import { moveAudioSelection } from "../lib/audio-segments.js";
import {
  audioTime,
  panWaveform,
  selectionView,
  waveformTime,
  waveformView,
} from "../lib/waveform-view.js";
import { useAudioDrag } from "./use-audio-drag.js";
import { dragAudioSelection, trimBounds } from "../lib/waveform-drag.js";
import type { Translate } from "./tools-ui.js";
type Source = { buffer: AudioBuffer; peaks: Float32Array };
export function Waveform({
  source,
  settings,
  cursor,
  update,
  t,
  split,
  active,
}: {
  active: boolean;
  split: boolean;
  source: Source;
  settings: AudioSettings;
  cursor: number;
  update: (patch: Partial<AudioSettings>) => void;
  t: Translate;
}) {
  const { duration } = source.buffer;
  const [panMode, setPanMode] = useState(false);
  const [navigation, setNavigation] = useState(() => ({
    buffer: source.buffer,
    window:
      duration > 30
        ? selectionView(duration, settings.start, settings.end)
        : { start: 0, span: duration },
  }));
  if (navigation.buffer !== source.buffer) {
    setPanMode(false);
    setNavigation({
      buffer: source.buffer,
      window:
        duration > 30
          ? selectionView(duration, settings.start, settings.end)
          : { start: 0, span: duration },
    });
  }
  const window = navigation.window;
  const windowEnd = window.start + window.span;
  const zoomed = window.span < duration;
  const panning = panMode && zoomed;
  function navigate(start: number, span = window.span) {
    setNavigation({ buffer: source.buffer, window: waveformView(duration, start, span) });
  }
  function fitSelection() {
    setPanMode(false);
    setNavigation({
      buffer: source.buffer,
      window: selectionView(duration, settings.start, settings.end),
    });
  }
  function reveal(time: number) {
    if (time < window.start || time > windowEnd) navigate(time - window.span / 2);
  }
  const panDrag = useRef<{ clientX: number; width: number; window: typeof window } | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const gesture = useAudioDrag({
    source: source.buffer,
    active,
    split,
    selection: { start: settings.start, end: settings.end },
    window,
    view,
    update,
    navigate: (next) => setNavigation({ buffer: source.buffer, window: next }),
  });
  const movable =
    Number.isFinite(settings.start) &&
    Number.isFinite(settings.end) &&
    settings.start >= 0 &&
    settings.end > settings.start &&
    settings.end <= duration;
  const selectionLength = movable ? settings.end - settings.start : 0;
  const safeStart = clamp(Number.isFinite(settings.start) ? settings.start : 0, 0, duration);
  const safeEnd = clamp(Number.isFinite(settings.end) ? settings.end : duration, 0, duration);
  const position = (time: number) => ((time - window.start) / window.span) * 100;
  const from = clamp(position(safeStart), 0, 100),
    to = clamp(position(safeEnd), 0, 100);
  const visibleSelection = movable && safeEnd >= window.start && safeStart <= windowEnd;
  const step = Math.min(0.01, duration / 100);
  const peaks = useMemo(() => {
    if (window.span === duration) return source.peaks;
    const first = Math.floor(window.start * source.buffer.sampleRate);
    const last = Math.ceil(windowEnd * source.buffer.sampleRate);
    return waveformPeaks(
      Array.from({ length: source.buffer.numberOfChannels }, (_, channel) =>
        source.buffer.getChannelData(channel).subarray(first, last),
      ),
    );
  }, [source, duration, window.start, window.span, windowEnd]);
  const pathFor = (values: Float32Array) =>
    Array.from(
      values,
      (peak, i) =>
        `M${((i + 0.5) / values.length) * 1000},${80 - Math.max(1, peak * 65)}v${Math.max(2, peak * 130)}`,
    ).join(" ");
  const path = pathFor(peaks);
  // Only draw boundaries in the visible window, with a bounded density at full-track zoom.
  const firstBoundary = Math.max(1, Math.ceil((window.start - safeStart) / MAX_DURATION));
  const lastBoundary = Math.min(
    Math.ceil(Math.round(selectionLength * SAMPLE_RATE) / MAX_SAMPLES) - 1,
    Math.floor((windowEnd - safeStart) / MAX_DURATION),
  );
  const boundaryStride = Math.max(1, Math.ceil((lastBoundary - firstBoundary + 1) / 200));
  const boundaries: number[] = [];
  for (let i = firstBoundary; i <= lastBoundary; i += boundaryStride) boundaries.push(i);
  return (
    <>
      <div className="wave-toolbar" aria-label={t("波形檢視", "Waveform view")}>
        <button
          type="button"
          className="studio-button secondary"
          onClick={fitSelection}
          disabled={!movable}
        >
          {t("聚焦選段", "Fit selection")}
        </button>
        <button
          type="button"
          className="studio-button secondary"
          onClick={() => {
            navigate(0, duration);
            setPanMode(false);
          }}
          disabled={!zoomed}
        >
          {t("顯示全曲", "Full track")}
        </button>
        <button
          type="button"
          className="studio-button secondary"
          aria-label={t("放大波形", "Zoom in waveform")}
          disabled={window.span <= Math.min(0.25, duration)}
          onClick={() => navigate(window.start + window.span / 4, window.span / 2)}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="studio-button secondary"
          aria-label={t("縮小波形", "Zoom out waveform")}
          disabled={!zoomed}
          onClick={() => navigate(window.start - window.span / 2, window.span * 2)}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className={`studio-button ${panning ? "primary" : "secondary"}`}
          aria-pressed={panning}
          disabled={!zoomed}
          onClick={() => setPanMode(!panning)}
        >
          {t("移動畫面", "Pan view")}
        </button>
      </div>
      <div
        className={`waveform ${panning ? "wave-pan-mode" : ""}`}
        ref={view}
        onPointerDown={(e) => {
          if (!zoomed || e.button !== 0 || (e.target as Element).closest("[data-wave-edit]"))
            return;
          e.preventDefault();
          (e.currentTarget.querySelector(".wave-pan-surface") as HTMLElement | null)?.focus({
            preventScroll: true,
          });
          e.currentTarget.setPointerCapture(e.pointerId);
          panDrag.current = {
            clientX: e.clientX,
            width: e.currentTarget.getBoundingClientRect().width,
            window,
          };
        }}
        onPointerMove={(e) => {
          const drag = panDrag.current;
          if (!drag || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          setNavigation({
            buffer: source.buffer,
            window: panWaveform(drag.window, duration, (e.clientX - drag.clientX) / drag.width),
          });
        }}
        onPointerUp={(e) => {
          panDrag.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          panDrag.current = null;
        }}
        onLostPointerCapture={() => {
          panDrag.current = null;
        }}
      >
        <svg viewBox="0 0 1000 160" preserveAspectRatio="none" aria-hidden="true">
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <div className="wave-dim left" style={{ width: `${from}%` }} />
        <div className="wave-dim right" style={{ width: `${100 - to}%` }} />
        <div
          className="wave-selection"
          data-wave-edit="true"
          style={{
            left: `${from}%`,
            width: `${Math.max(0, to - from)}%`,
            visibility: visibleSelection ? "visible" : "hidden",
          }}
          role="slider"
          tabIndex={visibleSelection && !panning ? 0 : -1}
          aria-label={t("移動選取片段", "Move selected clip")}
          aria-disabled={!visibleSelection || panning}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, duration - selectionLength)}
          aria-valuenow={movable ? settings.start : 0}
          aria-valuetext={t(
            `從 ${safeStart.toFixed(3)} 到 ${safeEnd.toFixed(3)} 秒`,
            `From ${safeStart.toFixed(3)} to ${safeEnd.toFixed(3)} seconds`,
          )}
          onPointerDown={(e) => {
            if (movable) gesture.begin("selection", e);
          }}
          onPointerMove={gesture.move}
          onPointerUp={gesture.end}
          onPointerCancel={gesture.finish}
          onLostPointerCapture={gesture.finish}
          onKeyDown={(e) => {
            if (!movable) return;
            const increment = step * (e.shiftKey ? 10 : 1);
            const delta =
              e.key === "Home"
                ? -duration
                : e.key === "End"
                  ? duration
                  : ["ArrowLeft", "ArrowDown"].includes(e.key)
                    ? -increment
                    : ["ArrowRight", "ArrowUp"].includes(e.key)
                      ? increment
                      : undefined;
            if (delta === undefined) return;
            e.preventDefault();
            const next = moveAudioSelection(settings.start, settings.end, duration, delta);
            update(next);
            reveal(delta < 0 ? next.start : next.end);
          }}
        />
        {split &&
          movable &&
          boundaries.map((index) => (
            <div
              key={index}
              className="wave-split"
              aria-hidden="true"
              style={{ left: `${position(safeStart + index * MAX_DURATION)}%` }}
            />
          ))}
        {(["start", "end"] as const)
          .filter((key) => {
            const time = key === "start" ? safeStart : safeEnd;
            return gesture.kind === key || (time >= window.start && time <= windowEnd);
          })
          .map((key) => (
            <div
              key={key}
              className={`wave-handle ${key}`}
              data-wave-edit="true"
              style={{ left: `${key === "start" ? from : to}%` }}
              tabIndex={panning ? -1 : 0}
              aria-disabled={panning}
              role="slider"
              aria-label={
                key === "start"
                  ? t("波形開始位置", "Waveform start")
                  : t("波形結束位置", "Waveform end")
              }
              aria-valuemin={
                trimBounds(key, { start: safeStart, end: safeEnd }, duration, split).min
              }
              aria-valuemax={
                trimBounds(key, { start: safeStart, end: safeEnd }, duration, split).max
              }
              aria-valuenow={Number.isFinite(settings[key]) ? settings[key] : 0}
              aria-valuetext={`${Number.isFinite(settings[key]) ? settings[key].toFixed(3) : 0} ${t("秒", "seconds")}`}
              onPointerDown={(e) => gesture.begin(key, e)}
              onPointerMove={gesture.move}
              onPointerUp={gesture.end}
              onPointerCancel={gesture.finish}
              onLostPointerCapture={gesture.finish}
              onKeyDown={(e) => {
                let v = key === "start" ? safeStart : safeEnd;
                if (e.key === "ArrowLeft" || e.key === "ArrowDown")
                  v -= step * (e.shiftKey ? 10 : 1);
                else if (e.key === "ArrowRight" || e.key === "ArrowUp")
                  v += step * (e.shiftKey ? 10 : 1);
                else if (e.key === "Home") v = 0;
                else if (e.key === "End") v = duration;
                else return;
                e.preventDefault();
                const next = dragAudioSelection(
                  key,
                  { start: safeStart, end: safeEnd },
                  duration,
                  v - (key === "start" ? safeStart : safeEnd),
                  split,
                  0,
                );
                reveal(next[key]);
                update(next);
              }}
            >
              <span aria-hidden="true">
                <Icon name="grip" />
              </span>
            </div>
          ))}
        {panning && (
          <div
            className="wave-pan-surface"
            role="slider"
            tabIndex={0}
            aria-label={t("拖曳移動畫面", "Drag to pan waveform")}
            aria-valuemin={0}
            aria-valuemax={duration - window.span}
            aria-valuenow={window.start}
            aria-valuetext={`${audioTime(window.start)} – ${audioTime(windowEnd)}`}
            onKeyDown={(e) => {
              const increment = window.span * (e.shiftKey ? 0.5 : 0.1);
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? duration
                    : ["ArrowLeft", "ArrowDown"].includes(e.key)
                      ? window.start - increment
                      : ["ArrowRight", "ArrowUp"].includes(e.key)
                        ? window.start + increment
                        : undefined;
              if (next === undefined) return;
              e.preventDefault();
              navigate(next);
            }}
          />
        )}
        {gesture.feedback && (
          <div className="wave-drag-feedback" role="status">
            {gesture.feedback === "left" && <Icon name="arrow-left" />}
            {gesture.feedback === "left"
              ? t("自動向前捲動", "Scrolling earlier")
              : gesture.feedback === "right"
                ? t("自動向後捲動", "Scrolling later")
                : gesture.feedback === "limit"
                  ? !split && selectionLength >= MAX_DURATION - 1 / SAMPLE_RATE
                    ? t("已達單檔 8.19 秒上限", "Single-file limit reached: 8.19 s")
                    : t("已到選段邊界", "Selection boundary reached")
                  : gesture.feedback === "moving"
                    ? t("移動片段 · 長度不變", "Moving clip · length preserved")
                    : t("調整裁切範圍", "Trimming selection")}
            {gesture.feedback === "right" && <Icon name="arrow" />}
          </div>
        )}
        {cursor >= window.start && cursor <= windowEnd && (
          <div className="wave-cursor" style={{ left: `${position(cursor)}%` }} />
        )}
      </div>
      <div className="wave-ticks">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f}>{audioTime(waveformTime(window, f))}</span>
        ))}
      </div>
      <div className="wave-scrollbar">
        <button
          type="button"
          className="studio-button secondary"
          disabled={window.start <= 0}
          onClick={() => navigate(window.start - window.span / 2)}
          aria-label={t("查看前一段", "View earlier audio")}
        >
          <Icon name="arrow-left" />
        </button>
        <input
          className="ui-range"
          type="range"
          aria-label={t("移動檢視範圍", "Move visible range")}
          min={0}
          max={Math.max(0, duration - window.span)}
          step="any"
          value={window.start}
          disabled={!zoomed}
          aria-valuetext={`${audioTime(window.start)} – ${audioTime(windowEnd)}`}
          onChange={(e) => navigate(Number(e.target.value))}
        />
        <button
          type="button"
          className="studio-button secondary"
          disabled={windowEnd >= duration}
          onClick={() => navigate(window.start + window.span / 2)}
          aria-label={t("查看後一段", "View later audio")}
        >
          <Icon name="arrow" />
        </button>
      </div>
      <div className="wave-context">
        <span>
          {audioTime(window.start)} – {audioTime(windowEnd)} / {audioTime(duration)}
        </span>
        {!visibleSelection && movable && (
          <button
            type="button"
            className="studio-button secondary"
            disabled={!movable}
            onClick={() => {
              const next = moveAudioSelection(
                safeStart,
                safeEnd,
                duration,
                window.start + window.span / 2 - (safeStart + safeEnd) / 2,
              );
              update(next);
              setPanMode(false);
              setNavigation({
                buffer: source.buffer,
                window: selectionView(duration, next.start, next.end),
              });
            }}
          >
            {t("將選段移到此處", "Move clip here")}
          </button>
        )}
      </div>
      <p className="control-hint" aria-live="polite">
        {panning
          ? t(
              "拖曳波形可移動畫面，不會改動選段。關閉「移動畫面」即可繼續裁切。",
              "Drag the waveform to pan without changing the selection. Turn off Pan view to resume trimming.",
            )
          : t(
              "拖曳片段可移動，把手可裁切；靠近畫面邊緣會自動捲動。方向鍵微調，Shift 加速。",
              "Drag the clip to move it or the handles to trim. Hold near an edge to scroll automatically. Arrows fine-tune; Shift moves faster.",
            )}
      </p>
    </>
  );
}
