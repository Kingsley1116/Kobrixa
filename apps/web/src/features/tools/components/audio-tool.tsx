import { Icon } from "../../../components/ui/icon.js";
import type { GalleryEditorProps } from "../../../shared/gallery.js";
import { useEffect, useRef, useState } from "react";
import { convertAudio, convertAudioSequence, demoAudio } from "../lib/media-browser.js";
import { MAX_DURATION, MAX_SAMPLES, sampleCount, SAMPLE_RATE } from "../lib/media.js";
import { DEFAULT_AUDIO, waveformPeaks } from "../lib/media-processing.js";
import type { AudioSettings } from "../lib/media-processing.js";
import {
  DownloadCard,
  DropZone,
  EmptyPreview,
  PanelTitle,
  Range,
  StudioStatus,
  StudioWorkflow,
  StudioWorkspace,
} from "./tools-ui.js";
import { Waveform } from "./audio-waveform.js";
import { AudioSequenceDownload } from "./audio-sequence-download.js";
import { sequenceSampleCount } from "../lib/audio-segments.js";
import { exportState, initialAudioSettings } from "../lib/tools-state.js";
import type { Translate } from "./tools-ui.js";

type Source = { buffer: AudioBuffer; name: string; size: number; peaks: Float32Array };

export function AudioTool({
  t,
  active,
  onExport,
  sourceLimit,
  durationLimit,
}: { t: Translate; active: boolean } & GalleryEditorProps) {
  const [source, setSource] = useState<Source>();
  const [settings, setSettings] = useState<AudioSettings>({ ...DEFAULT_AUDIO });
  const [name, setName] = useState("sound");
  const [exportMode, setExportMode] = useState<"single" | "sequence">("single");
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(false),
    [convertError, setConvertError] = useState(false),
    [playError, setPlayError] = useState(false);
  const [result, setResult] = useState<{
    source: Source;
    settings: AudioSettings;
    parts: Uint8Array<ArrayBuffer>[];
    mode: "single" | "sequence";
    clipped: number;
  }>();
  const [playing, setPlaying] = useState<"original" | "output" | null>(null),
    [cursor, setCursor] = useState(-1);
  const loadVersion = useRef(0),
    conversionVersion = useRef(0),
    playVersion = useRef(0),
    contexts = useRef(new Set<AudioContext>());
  const playback = useRef<{
    context: AudioContext;
    node: AudioBufferSourceNode;
    frame: number;
  } | null>(null);
  function stop() {
    playVersion.current++;
    const p = playback.current;
    playback.current = null;
    if (p) {
      cancelAnimationFrame(p.frame);
      p.node.onended = null;
      try {
        p.node.stop();
      } catch {
        /* Already stopped. */
      }
      p.node.disconnect();
      void p.context.close().catch(() => {});
    }
    setPlaying(null);
    setCursor(-1);
  }
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if (!active) stopRef.current();
  }, [active]);
  useEffect(() => {
    const owned = contexts.current;
    return () => {
      loadVersion.current++;
      conversionVersion.current++;
      stopRef.current();
      for (const c of owned) void c.close().catch(() => {});
      owned.clear();
    };
  }, []);
  function update(patch: Partial<AudioSettings>) {
    stop();
    setConvertError(false);
    setSettings((s) => ({ ...s, ...patch }));
  }
  async function pick(file: File) {
    stop();
    const id = ++loadVersion.current;
    setLoading(true);
    setLoadError(false);
    setPlayError(false);
    for (const c of contexts.current) void c.close().catch(() => {});
    contexts.current.clear();
    let context: AudioContext | undefined;
    try {
      if (sourceLimit && (file.size > sourceLimit || !/\.(mp3|wav|ogg)$/i.test(file.name)))
        throw new Error();
      context = new AudioContext();
      contexts.current.add(context);
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      if (id === loadVersion.current) {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
          buffer.getChannelData(i),
        );
        const peaks = waveformPeaks(channels);
        setConvertError(false);
        setResult(undefined);
        setSource({ buffer, name: file.name, size: file.size, peaks });
        setExportMode("single");
        setSettings(initialAudioSettings(buffer.duration));
        setName(file.name.replace(/\.[^.]+$/, "") || "sound");
      }
    } catch {
      if (id === loadVersion.current) setLoadError(true);
    } finally {
      if (context) {
        contexts.current.delete(context);
        if (context.state !== "closed") await context.close().catch(() => {});
      }
      if (id === loadVersion.current) setLoading(false);
    }
  }
  let count = 0;
  try {
    if (source)
      count = (exportMode === "sequence" ? sequenceSampleCount : sampleCount)(
        settings.start,
        settings.end,
        source.buffer.duration,
      );
  } catch {
    /* Range guidance below. */
  }
  const effectsValid =
    [settings.volume, settings.fadeIn, settings.fadeOut].every(Number.isFinite) &&
    settings.volume >= 0 &&
    settings.volume <= 200 &&
    settings.fadeIn >= 0 &&
    settings.fadeOut >= 0 &&
    settings.fadeIn <= settings.end - settings.start &&
    settings.fadeOut <= settings.end - settings.start;
  const valid =
    count > 0 && effectsValid && (!durationLimit || settings.end - settings.start <= durationLimit);
  const current =
    result?.source === source && result?.settings === settings && result?.mode === exportMode
      ? result
      : undefined;
  useEffect(() => {
    const id = ++conversionVersion.current;
    if (!source || !valid || !active) return;
    setConvertError(false);
    const debounce = window.setTimeout(() => {
      const conversion =
        exportMode === "sequence"
          ? convertAudioSequence(source.buffer, settings)
          : convertAudio(source.buffer, settings).then(({ bytes, clipped }) => ({
              parts: [bytes],
              clipped,
            }));
      void conversion
        .then((converted) => {
          if (id === conversionVersion.current)
            setResult({ source, settings, mode: exportMode, ...converted });
        })
        .catch(() => {
          if (id === conversionVersion.current) setConvertError(true);
        });
    }, 250);
    return () => {
      window.clearTimeout(debounce);
      conversionVersion.current++;
    };
  }, [source, settings, valid, active, exportMode]);
  async function play(kind: "original" | "output") {
    if (playing === kind) {
      stop();
      return;
    }
    stop();
    setPlayError(false);
    if (!source || !count || (kind === "output" && !current)) return;
    const id = playVersion.current;
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      const node = context.createBufferSource();
      if (kind === "original") node.buffer = source.buffer;
      else {
        const parts = current!.parts;
        const buffer = context.createBuffer(
          1,
          parts.reduce((sum, bytes) => sum + bytes.length - 8, 0),
          SAMPLE_RATE,
        );
        const channel = buffer.getChannelData(0);
        let offset = 0;
        for (const bytes of parts) {
          for (let i = 8; i < bytes.length; i++) channel[offset++] = (bytes[i]! - 128) / 128;
        }
        node.buffer = buffer;
      }
      node.connect(context.destination);
      const p = { context, node, frame: 0 };
      playback.current = p;
      await context.resume();
      if (id !== playVersion.current) {
        if (context.state !== "closed") void context.close().catch(() => {});
        return;
      }
      const started = context.currentTime;
      node.onended = () => {
        if (playback.current === p) stopRef.current();
      };
      node.start(
        0,
        kind === "original" ? settings.start : 0,
        kind === "original" ? settings.end - settings.start : undefined,
      );
      setPlaying(kind);
      const tick = () => {
        if (playback.current !== p) return;
        setCursor(Math.min(settings.end, settings.start + context!.currentTime - started));
        p.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      if (context && context.state !== "closed") void context.close().catch(() => {});
      if (id === playVersion.current) {
        stop();
        setPlayError(true);
      }
    }
  }
  const selected = Number.isFinite(settings.end - settings.start)
    ? Math.max(0, settings.end - settings.start)
    : 0;
  const state = exportState({
    hasSource: Boolean(source),
    loading,
    valid,
    failed: convertError,
    hasResult: Boolean(current),
    name,
  });
  useEffect(() => {
    onExport?.(
      state === "ready" && !loadError && current
        ? { kind: "audio", name, parts: current.parts }
        : undefined,
    );
  }, [state, loadError, current, name, onExport]);
  return (
    <div className="studio-editor">
      <StudioWorkflow kind="audio" hasSource={Boolean(source)} state={state} t={t} />
      <DropZone
        kind="audio"
        name={source?.name}
        info={
          source
            ? `${source.buffer.duration.toFixed(2)}s · ${t("解碼後", "Decoded")} ${(source.buffer.sampleRate / 1000).toFixed(1)} kHz · ${source.buffer.numberOfChannels} ch · ${(source.size / 1024).toFixed(1)} KB`
            : undefined
        }
        loading={loading}
        active={active}
        onFile={(file) => void pick(file)}
        onDemo={() => void pick(demoAudio())}
        t={t}
      />
      <StudioStatus state={state} t={t} />
      {loadError && (
        <p className="studio-error" role="alert">
          {t(
            "無法解碼音頻，請嘗試有效的 WAV 或 MP3。",
            "Cannot decode this audio. Try a valid WAV or MP3.",
          )}{" "}
          {source && t("原素材與設定已保留。", "Your previous file and settings have been kept.")}
        </p>
      )}
      {source ? (
        <StudioWorkspace
          kind="audio"
          preview={
            <div
              className="studio-preview-panel"
              id="audio-preview"
              tabIndex={-1}
              aria-label={t("調整與預覽", "Adjust & preview")}
            >
              <PanelTitle number="02" title={t("看見聲音的形狀", "See the shape of sound")} />
              {source ? (
                <>
                  <div className="wave-summary">
                    <div>
                      <span>{t("選取長度", "Selected duration")}</span>
                      <strong>
                        {selected.toFixed(3)}
                        <small> s</small>
                      </strong>
                    </div>
                    <span className={`tiny-badge ${!count ? "warning" : ""}`}>
                      {count
                        ? exportMode === "sequence"
                          ? t(
                              `${Math.ceil(count / MAX_SAMPLES)} 個 RSF 檔案`,
                              `${Math.ceil(count / MAX_SAMPLES)} RSF files`,
                            )
                          : `${count.toLocaleString()} / ${MAX_SAMPLES.toLocaleString()}`
                        : t("請調整範圍", "Adjust the range")}
                    </span>
                  </div>
                  <Waveform
                    active={active}
                    source={source}
                    split={exportMode === "sequence"}
                    settings={settings}
                    cursor={cursor}
                    update={update}
                    t={t}
                  />
                  <div className="capacity-track">
                    <span
                      style={{ width: `${Math.min(100, (selected / MAX_DURATION) * 100)}%` }}
                      className={!count ? "over" : ""}
                    />
                  </div>
                  <div className="preview-meta">
                    <span>
                      {count
                        ? `${(count + 8 * Math.ceil(count / MAX_SAMPLES)).toLocaleString()} bytes`
                        : t("超出範圍或選取無效", "Out of range or invalid selection")}
                    </span>
                    <span>
                      {exportMode === "sequence"
                        ? t("自動分段・虛線為切點", "Auto split · dashed lines mark boundaries")
                        : t("RSF 容量", "RSF capacity")}
                    </span>
                  </div>
                  <div className="audio-transport">
                    <button
                      className={`studio-button ${playing === "original" ? "primary" : "secondary"}`}
                      disabled={loading || !count}
                      onClick={() => void play("original")}
                    >
                      <span aria-hidden="true">
                        <Icon name={playing === "original" ? "stop" : "play"} />
                      </span>
                      {t("原音選段", "Original selection")}
                    </button>
                    <button
                      className={`studio-button ${playing === "output" ? "primary" : "secondary"}`}
                      disabled={loading || !current || !valid}
                      onClick={() => void play("output")}
                    >
                      <span aria-hidden="true">
                        <Icon name={playing === "output" ? "stop" : "play"} />
                      </span>
                      {t("EV3 輸出試聽", "EV3 output preview")}
                    </button>
                  </div>
                  <p className="control-hint">
                    {t(
                      "輸出試聽使用下載檔的實際量化音訊；實體喇叭的音色可能不同。",
                      "Output preview uses the exact quantized samples in the download. The physical speaker may sound different.",
                    )}
                  </p>
                  {exportMode === "sequence" && (
                    <p className="control-hint">
                      {t(
                        "EV3 依序播放各檔案，交界可能短暫停頓；此試聽不模擬換檔延遲。",
                        "EV3 plays the files in order and may pause at boundaries. This preview does not simulate file-loading delays.",
                      )}
                    </p>
                  )}
                  {playError && (
                    <p className="studio-error" role="alert">
                      {t(
                        "無法啟動播放，請再按一次試聽。",
                        "Playback could not start. Try the preview button again.",
                      )}
                    </p>
                  )}
                </>
              ) : (
                <EmptyPreview kind="audio" t={t} />
              )}
            </div>
          }
          settings={
            <aside className="studio-settings">
              <PanelTitle number="02" title={t("留下最好的片段", "Keep the best part")}>
                <button
                  className="studio-text-button"
                  onClick={() => {
                    stop();
                    setSettings({
                      ...initialAudioSettings(source.buffer.duration),
                      ...(exportMode === "sequence" ? { end: source.buffer.duration } : {}),
                    });
                    setConvertError(false);
                  }}
                >
                  {t("重設", "Reset")}
                </button>
              </PanelTitle>
              <fieldset className="studio-fieldset" disabled={loading}>
                <legend>{t("匯出方式", "Export mode")}</legend>
                <div className="segmented">
                  {(["single", "sequence"] as const).map((mode) => (
                    <button
                      key={mode}
                      aria-pressed={exportMode === mode}
                      onClick={() => {
                        if (mode === exportMode) return;
                        stop();
                        setConvertError(false);
                        setExportMode(mode);
                        if (mode === "single") {
                          const start =
                            Number.isFinite(settings.start) &&
                            settings.start >= 0 &&
                            settings.start < source.buffer.duration
                              ? settings.start
                              : 0;
                          const end = Math.min(
                            source.buffer.duration,
                            start + MAX_DURATION,
                            Number.isFinite(settings.end) && settings.end > start
                              ? settings.end
                              : source.buffer.duration,
                          );
                          update({
                            start,
                            end,
                            fadeIn: Math.min(settings.fadeIn, end - start),
                            fadeOut: Math.min(settings.fadeOut, end - start),
                          });
                        }
                      }}
                    >
                      {mode === "single"
                        ? t("單一檔案", "Single file")
                        : t("連續分段", "Auto split")}
                    </button>
                  ))}
                </div>
                <p className="control-hint">
                  {exportMode === "sequence"
                    ? t(
                        "將選取範圍連續切成每段最多約 8.19 秒的 RSF，附順序播放程式。",
                        "Split the selection into consecutive RSF files of up to ~8.19 seconds, with a playback program.",
                      )
                    : t(
                        "單一 RSF 最多約 8.19 秒。需要更長音訊時，請選擇連續分段。",
                        "One RSF holds up to ~8.19 seconds. Choose Auto split for longer audio.",
                      )}
                </p>
                {exportMode === "sequence" && (
                  <button
                    className="studio-button secondary full-width"
                    onClick={() => update({ start: 0, end: source.buffer.duration })}
                  >
                    {t("選取整段音訊", "Select entire audio")}
                  </button>
                )}
              </fieldset>
              <fieldset disabled={!source} className="studio-fieldset">
                <legend>{t("裁切範圍", "Trim range")}</legend>
                <div className="time-inputs">
                  {(["start", "end"] as const).map((key) => (
                    <label key={key}>
                      {key === "start"
                        ? t("開始（秒）", "Start (seconds)")
                        : t("結束（秒）", "End (seconds)")}
                      <input
                        className="ui-control"
                        type="number"
                        aria-invalid={!count}
                        aria-describedby={!count ? "audio-range-error" : "audio-range-hint"}
                        min={0}
                        max={source?.buffer.duration ?? 0}
                        step="any"
                        value={Number.isFinite(settings[key]) ? settings[key] : ""}
                        onChange={(e) => update({ [key]: e.target.valueAsNumber })}
                      />
                    </label>
                  ))}
                </div>
                <p id="audio-range-hint" className="control-hint">
                  {t(
                    "輸入精確時間，或拖曳波形把手。",
                    "Enter an exact time, or drag the waveform handles.",
                  )}
                </p>
                {source &&
                  exportMode === "single" &&
                  source.buffer.duration > MAX_DURATION &&
                  settings.start === 0 &&
                  settings.end === MAX_DURATION && (
                    <p className="control-hint">
                      {t(
                        "已選取前約 8.19 秒，可拖曳調整。",
                        "The first ~8.19 seconds are selected. Drag the handles to adjust.",
                      )}
                    </p>
                  )}
                {source && !count && (
                  <div id="audio-range-error" className="studio-error" role="alert">
                    <p>
                      {exportMode === "sequence"
                        ? t(
                            "請選擇大於零，且不超出原音訊的範圍。",
                            "Choose a non-empty range within the source audio.",
                          )
                        : t(
                            "請選擇大於零、最多約 8.19 秒，且不超出原音訊的片段。",
                            "Choose a non-empty clip within the source audio, up to ~8.19 seconds.",
                          )}
                    </p>
                    <button
                      className="studio-button secondary full-width"
                      onClick={() =>
                        update({
                          ...initialAudioSettings(source.buffer.duration),
                          ...(exportMode === "sequence" ? { end: source.buffer.duration } : {}),
                        })
                      }
                    >
                      {t("重設為可匯出的片段", "Reset to an exportable clip")}
                    </button>
                  </div>
                )}
                <Range
                  t={t}
                  label={t("音量", "Volume")}
                  min={0}
                  max={200}
                  value={settings.volume}
                  unit="%"
                  onChange={(volume) => update({ volume })}
                  hint={t(
                    "100% 保留原始音量；超過會放大。",
                    "100% keeps the original level; higher values amplify it.",
                  )}
                />
                <details className="studio-advanced">
                  <summary className="ui-disclosure">{t("聲音修飾", "Sound finishing")}</summary>
                  {exportMode === "sequence" && (
                    <p className="control-hint">
                      {t(
                        "效果套用於整個選取範圍；不會在每個分段重新淡入淡出或正規化。",
                        "Effects apply across the selection. Fades and normalization do not restart at each split.",
                      )}
                    </p>
                  )}
                  <label className="studio-check ui-choice-label">
                    <input
                      className="ui-choice"
                      type="checkbox"
                      checked={settings.normalize}
                      onChange={(e) => update({ normalize: e.target.checked })}
                    />
                    {t("峰值正規化至 −1 dBFS", "Normalize peak to −1 dBFS")}
                  </label>
                  <p className="control-hint">
                    {t(
                      "先調整峰值，再套用音量與淡入淡出。靜音保持靜音。",
                      "Adjusts the peak before volume and fades. Silence stays silent.",
                    )}
                  </p>
                  <Range
                    t={t}
                    label={t("淡入", "Fade in")}
                    min={0}
                    max={selected}
                    step={0.01}
                    value={settings.fadeIn}
                    unit="s"
                    onChange={(fadeIn) => update({ fadeIn })}
                    hint={t("讓片段開頭平順進入。", "Soften the beginning of the clip.")}
                  />
                  <Range
                    t={t}
                    label={t("淡出", "Fade out")}
                    min={0}
                    max={selected}
                    step={0.01}
                    value={settings.fadeOut}
                    unit="s"
                    onChange={(fadeOut) => update({ fadeOut })}
                    hint={t("讓片段結尾平順收尾。", "Soften the end of the clip.")}
                  />
                </details>
              </fieldset>
              {source && count > 0 && !effectsValid && (
                <p className="studio-error" role="alert">
                  {t(
                    "請檢查音量；淡入／淡出不能超過片段長度。",
                    "Check the volume; fades cannot exceed the clip length.",
                  )}
                </p>
              )}
              {convertError && (
                <p className="studio-error" role="alert">
                  {t(
                    "轉換失敗，請調整設定或重新匯入音頻。",
                    "Conversion failed. Adjust the settings or import the audio again.",
                  )}
                </p>
              )}
              {Boolean(current?.clipped) && (
                <p className="studio-warning" role="status">
                  {t(
                    "放大後部分樣本已削波，可能產生失真。請降低音量。",
                    "Some amplified samples are clipped and may sound distorted. Reduce the volume.",
                  )}
                </p>
              )}
              <div className="format-note">
                <span>EV3 / RSF</span>
                <p>8 kHz · {t("單聲道", "Mono")} · 8-bit PCM</p>
                <small>
                  {t(
                    "每個檔案最多 65,535 樣本，約 8.19 秒。",
                    "Each file holds up to 65,535 samples, about 8.19 seconds.",
                  )}
                </small>
              </div>
            </aside>
          }
          download={
            exportMode === "sequence" ? (
              <AudioSequenceDownload
                parts={valid ? current?.parts : undefined}
                name={name}
                setName={setName}
                state={state}
                t={t}
              />
            ) : (
              <DownloadCard
                bytes={valid ? current?.parts[0] : undefined}
                name={name}
                setName={setName}
                extension="rsf"
                t={t}
                state={state}
              />
            )
          }
        />
      ) : (
        <EmptyPreview kind="audio" t={t} />
      )}
    </div>
  );
}
