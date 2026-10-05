import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  calibrate,
  calibrationCode,
  identityCalibration,
  validateCalibration,
} from "../../shared/sensor-calibration.js";
import {
  channelReading,
  type CalibratedChannel,
  type SensorCalibration,
  type SensorChannel,
  type SensorFrame,
  type SensorLabStopReason,
  type SensorRecording,
} from "../../shared/sensor-lab.js";
import { Dialog, DialogActions } from "../components/dialog.js";
import { Picker } from "../components/picker.js";
import type { Locale } from "../i18n/copy.js";
import type { MonitorController, MonitorState } from "./monitor-controller.js";
import {
  SensorLabChart,
  chartNumber,
  type SensorChartPoint,
  type SensorChartSeries,
} from "./sensor-lab-chart.js";
import type { SensorLabController } from "./sensor-lab-controller.js";

const labels = {
  en: {
    title: "Curves & calibration",
    sources: "Channels",
    choose: "Choose up to 4 channels",
    noSources: "Connect a sensor or motor to select a channel.",
    connect: "Connect EV3",
    selected: "selected",
    input: "Input",
    output: "Output",
    channel: "Channel",
    angle: "Angle",
    start: "Start recording",
    stop: "Stop recording",
    recording: "Recording",
    waiting: "Waiting for readings",
    raw: "Raw",
    calibrated: "Calibrated",
    valueMode: "Values",
    expand: "Expand charts",
    close: "Close",
    current: "Current",
    comparison: "Comparison",
    noComparison: "No comparison",
    clearComparison: "Remove comparison",
    preview: "Live preview",
    history: "Saved recordings",
    refresh: "Refresh",
    open: "View",
    compare: "Compare",
    remove: "Delete",
    export: "Export CSV",
    noHistory: "Your recordings are saved here automatically.",
    name: "Recording name",
    defaultName: "Sensor experiment",
    loading: "Loading recordings…",
    saved: "Saved locally",
    saving: "Saving locally…",
    retry: "Retry saving",
    samples: "samples",
    liveWindow: "Latest 60 seconds",
    full: "Full recording",
    inspect: "Inspect elapsed time",
    noValue: "No reading",
    calibration: "Calibration",
    calibrationChannel: "Channel to calibrate",
    twoPoint: "Two-point scaling",
    rawA: "Measured A",
    rawB: "Measured B",
    targetA: "Target A",
    targetB: "Target B",
    capture: "Capture current",
    unit: "Output unit",
    zero: "Zero current reading",
    resetZero: "Clear zero offset",
    zeroOffset: "Zero offset",
    resetCalibration: "Reset calibration",
    result: "Live result",
    apply: "Apply calibration",
    invalid: "Enter finite numbers; measured A and B must differ. The scale must be finite.",
    savedProfiles: "Calibration profiles",
    profileName: "Profile name",
    saveProfile: "Save profile",
    useProfile: "Apply profile",
    noProfiles: "No saved profiles for this channel.",
    code: "BASIC Plus program",
    copy: "Copy program",
    copied: "Copied",
    copyError: "Could not copy. Select the program and copy it manually.",
    dismiss: "Dismiss",
    codeUnavailable: "A direct-reading example is unavailable for this sensor configuration.",
    invalidUnit: "Use an output unit without control characters, up to 32 characters.",
    calibrationHint:
      "Scaling and zeroing apply in this tool and the generated program. They do not change EV3 sensor firmware.",
    recordingHint:
      "Recording continues when you switch tabs or minimize the window. Sampling waits 500 ms after each completed read; actual intervals are longer. Times use actual receipt timestamps.",
    interval: "Latest interval",
    lockedHint: "Stop recording to change channels or calibration.",
    frozenHint:
      "Saved recordings use their original calibration. Changes apply to future recordings.",
    deleteTitle: "Delete recording?",
    deleteBody: "This permanently removes the saved recording from this computer.",
    deleteProfileTitle: "Delete calibration profile?",
    cancel: "Cancel",
    gap: "Missing readings appear as gaps.",
    comparisonUnits: "Comparison omitted where calibrated units differ.",
    detached: "Channel is no longer available",
    noSelection: "Select a channel to view a curve and configure its calibration.",
    calibrateLive: "Use live preview to configure calibration.",
    limit: "Recording reached its limit.",
    unsaved: "Not saved",
    profileDefault: "Sensor calibration",
    complete: "Stopped",
  },
  "zh-TW": {
    title: "曲線與校正",
    sources: "通道",
    choose: "最多選擇 4 個通道",
    noSources: "連接感測器或馬達，即可選擇通道。",
    connect: "連接 EV3",
    selected: "已選",
    input: "輸入埠",
    output: "輸出埠",
    channel: "通道",
    angle: "角度",
    start: "開始記錄",
    stop: "停止記錄",
    recording: "記錄中",
    waiting: "等待讀值",
    raw: "原始",
    calibrated: "校正後",
    valueMode: "數值",
    expand: "放大圖表",
    close: "關閉",
    current: "本次",
    comparison: "比較",
    noComparison: "不比較",
    clearComparison: "移除比較",
    preview: "即時預覽",
    history: "已存記錄",
    refresh: "重新整理",
    open: "查看",
    compare: "比較",
    remove: "刪除",
    export: "匯出 CSV",
    noHistory: "記錄會自動儲存在這裡。",
    name: "記錄名稱",
    defaultName: "感測器實驗",
    loading: "正在載入記錄…",
    saved: "已儲存於本機",
    saving: "正在儲存於本機…",
    retry: "重試儲存",
    samples: "筆",
    liveWindow: "最近 60 秒",
    full: "完整記錄",
    inspect: "查看時間點",
    noValue: "無讀值",
    calibration: "校正",
    calibrationChannel: "校正通道",
    twoPoint: "兩點換算",
    rawA: "實測值 A",
    rawB: "實測值 B",
    targetA: "目標值 A",
    targetB: "目標值 B",
    capture: "擷取目前值",
    unit: "輸出單位",
    zero: "將目前值歸零",
    resetZero: "清除歸零偏移",
    zeroOffset: "歸零偏移",
    resetCalibration: "重設校正",
    result: "即時結果",
    apply: "套用校正",
    invalid: "請輸入有限數值，且實測 A、B 必須不同，換算倍率也必須是有限數值。",
    savedProfiles: "校正設定檔",
    profileName: "設定檔名稱",
    saveProfile: "儲存設定檔",
    useProfile: "套用設定檔",
    noProfiles: "這個通道尚無已存設定檔。",
    code: "BASIC Plus 程式",
    copy: "複製程式",
    copied: "已複製",
    copyError: "無法複製，請選取程式碼後手動複製。",
    dismiss: "關閉訊息",
    codeUnavailable: "此感測器配置目前無法產生直接讀值範例。",
    invalidUnit: "輸出單位最多 32 個字元，且不得包含控制字元。",
    calibrationHint: "換算與歸零會套用在此工具和產生的程式中，不會修改 EV3 感測器韌體。",
    recordingHint:
      "切換分頁或最小化視窗仍會持續記錄。每次讀取完成後會等待 500 毫秒再取樣，實際間隔會更長；時間採用實際收到讀值的時刻。",
    interval: "最近取樣間隔",
    lockedHint: "請先停止記錄，再修改通道或校正。",
    frozenHint: "已存記錄使用記錄當時的校正參數；修改只影響之後的記錄。",
    deleteTitle: "刪除記錄？",
    deleteBody: "這會從本機永久刪除此筆記錄。",
    deleteProfileTitle: "刪除校正設定檔？",
    cancel: "取消",
    gap: "缺少讀值時，曲線會留白。",
    comparisonUnits: "校正後單位不同的通道不會疊圖。",
    detached: "此通道已無法讀取",
    noSelection: "選擇通道，即可查看曲線與設定校正。",
    calibrateLive: "切換至即時預覽，即可設定校正。",
    limit: "記錄已達上限。",
    unsaved: "尚未儲存",
    profileDefault: "感測器校正",
    complete: "已停止",
  },
};
export function channelLabel(source: SensorChannel, locale: Locale): string {
  const t = labels[locale];
  return source.kind === "output"
    ? `${t.output} ${String.fromCharCode(65 + source.port)} · ${t.angle}`
    : `${t.input} ${source.port + 1} · ${source.modeName || source.name} · ${t.channel} ${source.channel + 1}`;
}

export function recordingPoints(
  frames: readonly SensorFrame[],
  channel: CalibratedChannel,
  index: number,
  calibrated: boolean,
): SensorChartPoint[] {
  const points: SensorChartPoint[] = [];
  let segment: number | undefined;
  for (const frame of frames) {
    if (segment !== undefined && segment !== frame.segment)
      points.push({ time: frame.elapsedMs, value: null });
    const raw = frame.status === "ok" ? (frame.values[index] ?? null) : null;
    points.push({
      time: frame.elapsedMs,
      value: raw === null ? null : calibrated ? calibrate(raw, channel.calibration) : raw,
    });
    segment = frame.segment;
  }
  return points;
}

export function recordingSeries(
  channel: CalibratedChannel,
  index: number,
  frames: readonly SensorFrame[],
  comparison: SensorRecording | undefined,
  calibrated: boolean,
  locale: Locale,
): SensorChartSeries[] {
  const series: SensorChartSeries[] = [
    { label: labels[locale].current, points: recordingPoints(frames, channel, index, calibrated) },
  ];
  const otherIndex =
    comparison?.channels.findIndex((item) => item.source.id === channel.source.id) ?? -1;
  const other = comparison?.channels[otherIndex];
  if (comparison && other && (!calibrated || other.calibration.unit === channel.calibration.unit)) {
    series.push({
      label: labels[locale].comparison,
      points: recordingPoints(comparison.frames, other, otherIndex, calibrated),
      comparison: true,
    });
  }
  return series;
}

export function nearestChartValue(
  points: readonly SensorChartPoint[],
  time: number,
): number | null {
  let nearest: SensorChartPoint | undefined;
  for (const point of points) {
    if (!nearest || Math.abs(point.time - time) <= Math.abs(nearest.time - time)) nearest = point;
  }
  return nearest && Math.abs(nearest.time - time) <= 1500 ? nearest.value : null;
}

function duration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A stalled request must not leave Capture/Zero enabled on the previous value. */
function useFreshReading(monitor: MonitorState): boolean {
  const [, refresh] = useState(0);
  const sampledAt = monitor.snapshot?.sampledAt;
  useEffect(() => {
    if (monitor.status !== "live" || sampledAt === undefined) return;
    const timer = setTimeout(
      () => refresh((value) => value + 1),
      Math.max(0, Math.min(2501, sampledAt + 2501 - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [monitor.status, monitor.sessionId, sampledAt]);
  return isFreshMonitorReading(monitor);
}
function isFreshMonitorReading(monitor: MonitorState): boolean {
  const age = monitor.snapshot ? Date.now() - monitor.snapshot.sampledAt : Infinity;
  return monitor.status === "live" && !!monitor.sessionId && age >= 0 && age <= 2500;
}

function stopReason(reason: SensorLabStopReason | undefined, locale: Locale): string {
  const messages: Record<SensorLabStopReason, [string, string]> = {
    manual: ["Stopped by you", "已手動停止"],
    limit: ["Recording limit reached", "記錄已達上限"],
    "source-changed": ["Sensor or mode changed", "感測器或模式已變更"],
    disconnected: ["EV3 disconnected", "EV3 已斷線"],
    suspend: ["Computer went to sleep", "電腦已進入睡眠"],
    close: ["App closed", "應用程式已關閉"],
    update: ["App update", "應用程式更新"],
    interrupted: ["Recovered after interruption", "已復原中斷的記錄"],
  };
  return reason ? messages[reason][locale === "zh-TW" ? 1 : 0] : "";
}

export function SensorLabPanel({
  controller,
  monitor,
  locale,
  sessionId,
  onConnect,
  locked = false,
}: {
  controller: SensorLabController;
  monitor: MonitorController;
  locale: Locale;
  sessionId: string | undefined;
  onConnect(): void;
  locked?: boolean;
}): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const monitorState = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot);
  const freshReading = useFreshReading(monitorState);
  const t = labels[locale];
  const [name, setName] = useState("");
  const valueModeId = useId();
  const [calibrated, setCalibrated] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [choosingChannels, setChoosingChannels] = useState(true);
  const [deleteId, setDeleteId] = useState<string>();
  useEffect(() => {
    void controller.initialize();
  }, [controller]);
  useEffect(() => controller.observeMonitor(monitorState), [controller, monitorState]);
  useEffect(() => {
    if (state.lab.active) setChoosingChannels(false);
  }, [state.lab.active]);
  const disabled = locked || state.lab.active || state.busy || state.loading;
  const current = state.current;
  const channels = current?.channels ?? state.selected;
  const frames = current?.frames ?? state.preview;
  const last = frames.at(-1)?.elapsedMs ?? 0;
  const live = !current || (state.lab.active && current.id === state.lab.recording?.id);
  const end = Math.max(
    1000,
    current?.durationMs ?? last,
    !live ? (state.comparison?.durationMs ?? 0) : 0,
  );
  const domain: [number, number] = [live ? Math.max(0, end - 60_000) : 0, end];
  const fresh = freshReading && !!sessionId && monitorState.sessionId === sessionId;
  const canStart =
    fresh &&
    state.selected.length > 0 &&
    state.selected.every(
      ({ source, calibration }) =>
        state.available.some((item) => item.id === source.id) && !validateCalibration(calibration),
    );
  const allSources = [
    ...state.available,
    ...state.selected
      .map((item) => item.source)
      .filter((source) => !state.available.some((item) => item.id === source.id)),
  ];
  const recentSamples = frames.filter((frame) => frame.status === "ok").slice(-2);
  const interval =
    recentSamples.length === 2
      ? recentSamples[1]!.sampledAt - recentSamples[0]!.sampledAt
      : undefined;
  return (
    <section className="sensor-lab" aria-label={t.title} data-testid="sensor-lab">
      <div className="sensor-lab-controls">
        <div className="sensor-lab-actions">
          {state.lab.active ? (
            <button
              data-testid="sensor-lab-stop"
              className="primary"
              disabled={state.busy}
              onClick={() => void controller.stop()}
            >
              {t.stop}
            </button>
          ) : (
            <button
              data-testid="sensor-lab-start"
              className="primary"
              disabled={disabled || !canStart}
              onClick={() =>
                sessionId &&
                isFreshMonitorReading(monitorState) &&
                void controller.start(sessionId, name.trim() || t.defaultName)
              }
            >
              {t.start}
            </button>
          )}
          <button disabled={!channels.length} onClick={() => setExpanded(true)}>
            {t.expand}
          </button>
        </div>
        <div className="sensor-lab-recording-meta" data-testid="sensor-lab-recording-state">
          <strong>
            {state.lab.active
              ? state.lab.waiting
                ? t.waiting
                : t.recording
              : current
                ? t.complete
                : t.preview}
          </strong>
          <span>
            {duration(current?.durationMs ?? last)} · {frames.length} {t.samples}
          </span>
        </div>
        <p className="sensor-lab-save-state" data-unsaved={!state.lab.saved}>
          {state.lab.saved ? t.saved : state.lab.error ? t.unsaved : t.saving}
          {!state.lab.saved && !state.lab.active && (
            <button disabled={state.busy} onClick={() => void controller.retrySave()}>
              {t.retry}
            </button>
          )}
        </p>
        {interval !== undefined && (
          <p className="sensor-lab-hint">
            {t.interval}: {chartNumber(interval)} ms
          </p>
        )}
      </div>
      {state.loading && <p role="status">{t.loading}</p>}
      {(state.error || state.lab.error) && (
        <div className="sensor-lab-error" role="alert">
          <p>{state.error || state.lab.error}</p>
          {state.error && <button onClick={() => controller.dismissError()}>{t.dismiss}</button>}
        </div>
      )}
      {state.lab.issues.map((issue, i) => (
        <p className="sensor-lab-hint" key={`${i}-${issue}`}>
          {issue}
        </p>
      ))}
      {current?.reason && <p className="sensor-lab-hint">{stopReason(current.reason, locale)}</p>}
      {!sessionId && <button onClick={onConnect}>{t.connect}</button>}
      {!fresh && !current && sessionId && (
        <p className="sensor-lab-hint" role="status">
          {t.waiting}
        </p>
      )}
      <details
        className="sensor-lab-section"
        open={choosingChannels}
        onToggle={(event) => setChoosingChannels(event.currentTarget.open)}
      >
        <summary>
          {t.sources} · {state.selected.length}/4 {t.selected}
        </summary>
        <p className="sensor-lab-hint">{t.choose}</p>
        <fieldset className="sensor-lab-channel-list" disabled={disabled}>
          <legend className="sensor-lab-sr-only">{t.choose}</legend>
          {allSources.map((source) => {
            const checked = state.selected.some((item) => item.source.id === source.id);
            const available = state.available.some((item) => item.id === source.id);
            return (
              <label key={source.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && (!available || state.selected.length >= 4)}
                  onChange={() => controller.toggleChannel(source)}
                />
                <span>
                  {channelLabel(source, locale)}
                  {!available && <small>{t.detached}</small>}
                </span>
              </label>
            );
          })}
          {!allSources.length && <p className="sensor-lab-hint">{t.noSources}</p>}
        </fieldset>
        <label className="sensor-lab-field">
          {t.name}
          <input
            maxLength={100}
            disabled={disabled}
            value={name}
            placeholder={t.defaultName}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
      </details>
      {state.lab.active && <p className="sensor-lab-hint">{t.lockedHint}</p>}
      <div className="sensor-lab-actions sensor-lab-view-controls">
        <div className="sensor-lab-field">
          <label htmlFor={valueModeId}>{t.valueMode}</label>
          <Picker
            id={valueModeId}
            label={t.valueMode}
            locale={locale}
            value={calibrated ? "calibrated" : "raw"}
            onChange={(value) => setCalibrated(value === "calibrated")}
            options={[
              { value: "raw", label: t.raw },
              { value: "calibrated", label: t.calibrated },
            ]}
          />
        </div>
        {current && !state.lab.active && (
          <button onClick={() => controller.useLivePreview()}>{t.preview}</button>
        )}
      </div>
      {current && (
        <p className="sensor-lab-current-name">
          <strong>{current.name}</strong>
          <br />
          <time dateTime={new Date(current.startedAt).toISOString()}>
            {new Date(current.startedAt).toLocaleString(locale)}
          </time>
        </p>
      )}
      <div className="sensor-lab-legend">
        <span className="sensor-lab-series-current">{t.current}</span>
        {state.comparison && (
          <span className="sensor-lab-series-comparison">
            {t.comparison}: {state.comparison.name}
          </span>
        )}
      </div>
      {state.comparison && (
        <button className="sensor-lab-text-button" onClick={() => controller.clearComparison()}>
          {t.clearComparison}
        </button>
      )}
      <p className="sensor-lab-hint">
        {live ? t.liveWindow : t.full} · {t.gap}
      </p>
      {calibrated && state.comparison && <p className="sensor-lab-hint">{t.comparisonUnits}</p>}
      {!channels.length && <p className="sensor-lab-empty">{t.noSelection}</p>}
      <ChartStack
        channels={channels}
        frames={frames}
        comparison={state.comparison}
        calibrated={calibrated}
        domain={domain}
        locale={locale}
      />
      {current && (
        <button
          disabled={state.busy || state.lab.active}
          onClick={() => void controller.exportRecording(current.id)}
        >
          {t.export}
        </button>
      )}
      <details className="sensor-lab-section">
        <summary>{t.calibration}</summary>
        <p className="sensor-lab-hint">{t.calibrationHint}</p>
        <p className="sensor-lab-hint">{t.frozenHint}</p>
        <CalibrationEditor
          controller={controller}
          monitor={monitorState}
          locale={locale}
          disabled={disabled}
        />
      </details>
      <details className="sensor-lab-section">
        <summary>
          {t.history} ({state.history.length})
        </summary>
        <button disabled={state.busy} onClick={() => void controller.refresh()}>
          {t.refresh}
        </button>
        {!state.history.length && <p className="sensor-lab-hint">{t.noHistory}</p>}
        <ul className="sensor-lab-history">
          {state.history.map((recording) => (
            <li key={recording.id}>
              <strong>{recording.name}</strong>
              <time dateTime={new Date(recording.startedAt).toISOString()}>
                {new Date(recording.startedAt).toLocaleString(locale)}
              </time>
              <span>
                {duration(recording.durationMs)} · {recording.frameCount} {t.samples}
              </span>
              <div className="sensor-lab-actions">
                <button
                  disabled={state.busy || state.lab.active}
                  onClick={() => void controller.readRecording(recording.id)}
                >
                  {t.open}
                </button>
                <button
                  disabled={state.busy || current?.id === recording.id}
                  onClick={() => void controller.readRecording(recording.id, true)}
                >
                  {t.compare}
                </button>
                <button
                  disabled={state.busy}
                  onClick={() => void controller.exportRecording(recording.id)}
                >
                  {t.export}
                </button>
                <button
                  disabled={state.busy || state.lab.active}
                  onClick={() => setDeleteId(recording.id)}
                >
                  {t.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </details>
      <p className="sensor-lab-hint">{t.recordingHint}</p>
      {expanded && (
        <ExpandedCharts
          channels={channels}
          frames={frames}
          comparison={state.comparison}
          calibrated={calibrated}
          locale={locale}
          end={end}
          live={live}
          onClose={() => setExpanded(false)}
        />
      )}
      {deleteId && (
        <Dialog
          title={t.deleteTitle}
          onClose={() => {
            if (!state.busy) setDeleteId(undefined);
          }}
          role="alertdialog"
        >
          <p>{t.deleteBody}</p>
          <DialogActions>
            <button data-modal-initial disabled={state.busy} onClick={() => setDeleteId(undefined)}>
              {t.cancel}
            </button>
            <button
              className="danger"
              disabled={state.busy}
              onClick={() =>
                void controller.deleteRecording(deleteId).then((ok) => {
                  if (ok) setDeleteId(undefined);
                })
              }
            >
              {t.remove}
            </button>
          </DialogActions>
          {state.error && (
            <p className="sensor-lab-error" role="alert">
              {state.error}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}

function ChartStack({
  channels,
  frames,
  comparison,
  calibrated,
  domain,
  locale,
  cursor,
}: {
  channels: readonly CalibratedChannel[];
  frames: readonly SensorFrame[];
  comparison: SensorRecording | undefined;
  calibrated: boolean;
  domain: [number, number];
  locale: Locale;
  cursor?: number;
}): React.JSX.Element {
  const t = labels[locale];
  return (
    <div className="sensor-lab-charts">
      {channels.map((channel, index) => {
        const series = recordingSeries(channel, index, frames, comparison, calibrated, locale);
        const unit = calibrated ? channel.calibration.unit : channel.source.unit;
        const value =
          cursor === undefined
            ? series[0]!.points.at(-1)?.value
            : nearestChartValue(series[0]!.points, cursor);
        return (
          <article className="sensor-lab-chart-card" key={channel.source.id}>
            <header>
              <h4>{channelLabel(channel.source, locale)}</h4>
              <strong>
                {value === null || value === undefined ? t.noValue : chartNumber(value)} {unit}
              </strong>
            </header>
            <SensorLabChart
              title={channelLabel(channel.source, locale)}
              unit={unit}
              series={series}
              domain={domain}
              locale={locale}
              {...(cursor === undefined ? {} : { cursor })}
            />
            {cursor !== undefined && series[1] && (
              <p className="sensor-lab-hint">
                {t.comparison}:{" "}
                {nearestChartValue(series[1].points, cursor) === null
                  ? t.noValue
                  : chartNumber(nearestChartValue(series[1].points, cursor)!)}{" "}
                {unit}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

function ExpandedCharts({
  channels,
  frames,
  comparison,
  calibrated,
  locale,
  end,
  live,
  onClose,
}: {
  channels: readonly CalibratedChannel[];
  frames: readonly SensorFrame[];
  comparison: SensorRecording | undefined;
  calibrated: boolean;
  locale: Locale;
  end: number;
  live: boolean;
  onClose(): void;
}): React.JSX.Element {
  const t = labels[locale];
  const [full, setFull] = useState(!live);
  const [time, setTime] = useState<number>();
  const domain: [number, number] = [full ? 0 : Math.max(0, end - 60_000), end];
  const cursor = Math.max(domain[0], Math.min(end, time ?? end));
  return (
    <Dialog className="sensor-lab-expanded" title={t.title} onClose={onClose}>
      <div className="sensor-lab-actions">
        <button data-modal-initial onClick={onClose}>
          {t.close}
        </button>
        <Picker
          label={t.full}
          locale={locale}
          value={full ? "full" : "recent"}
          onChange={(value) => setFull(value === "full")}
          options={[
            { value: "recent", label: t.liveWindow },
            { value: "full", label: t.full },
          ]}
        />
      </div>
      <label className="sensor-lab-field">
        {t.inspect}: {chartNumber(cursor / 1000)} s
        <input
          type="range"
          min={domain[0]}
          max={end}
          step="100"
          value={cursor}
          onChange={(event) => setTime(Number(event.currentTarget.value))}
        />
      </label>
      <div className="sensor-lab-legend">
        <span className="sensor-lab-series-current">{t.current}</span>
        {comparison && (
          <span className="sensor-lab-series-comparison">
            {t.comparison}: {comparison.name}
          </span>
        )}
      </div>
      <ChartStack
        channels={channels}
        frames={frames}
        comparison={comparison}
        calibrated={calibrated}
        domain={domain}
        locale={locale}
        cursor={cursor}
      />
    </Dialog>
  );
}

function CalibrationEditor({
  controller,
  monitor,
  locale,
  disabled,
}: {
  controller: SensorLabController;
  monitor: MonitorState;
  locale: Locale;
  disabled: boolean;
}): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [channelId, setChannelId] = useState("");
  const pickerId = useId();
  const current = state.selected.find((item) => item.source.id === channelId) ?? state.selected[0];
  const t = labels[locale];
  if (!current) return <p className="sensor-lab-hint">{t.noSelection}</p>;
  return (
    <>
      <div className="sensor-lab-field">
        <label htmlFor={pickerId}>{t.calibrationChannel}</label>
        <Picker
          id={pickerId}
          label={t.calibrationChannel}
          locale={locale}
          disabled={disabled}
          value={current.source.id}
          onChange={(value) => setChannelId(value)}
          options={state.selected.map(({ source }) => ({
            value: source.id,
            label: channelLabel(source, locale),
          }))}
        />
      </div>
      <CalibrationForm
        key={current.source.id}
        channel={current}
        controller={controller}
        monitor={monitor}
        locale={locale}
        disabled={disabled}
      />
    </>
  );
}

function CalibrationForm({
  channel,
  controller,
  monitor,
  locale,
  disabled,
}: {
  channel: CalibratedChannel;
  controller: SensorLabController;
  monitor: MonitorState;
  locale: Locale;
  disabled: boolean;
}): React.JSX.Element {
  const t = labels[locale];
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const id = useId();
  const fresh = useFreshReading(monitor);
  const [draft, setDraft] = useState(() => calibrationDraft(channel.calibration));
  const [profileName, setProfileName] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [deleteProfile, setDeleteProfile] = useState<string>();
  useEffect(() => {
    setDraft(calibrationDraft(channel.calibration));
    setCopied(false);
  }, [channel.calibration, state.lab.active]);
  const calibration = parseCalibrationDraft(draft);
  const valid = !!calibration && !validateCalibration(calibration);
  const raw = fresh && monitor.snapshot ? channelReading(monitor.snapshot, channel.source) : null;
  const result = valid && raw !== null ? calibrate(raw, calibration!) : null;
  let code = "";
  if (valid) {
    try {
      code = calibrationCode(channel.source, calibration!, locale);
    } catch {
      /* Unsupported devices still support raw curves. */
    }
  }
  const profiles = state.profiles.filter((profile) => profile.source.id === channel.source.id);
  const setField = (key: keyof typeof draft, value: string | boolean) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setCopied(false);
    setCopyError(false);
  };
  const fields = ["sourceA", "targetA", "sourceB", "targetB"] as const;
  const fieldLabels = { sourceA: t.rawA, targetA: t.targetA, sourceB: t.rawB, targetB: t.targetB };
  return (
    <div className="sensor-lab-calibration" data-testid="sensor-lab-calibration">
      <fieldset disabled={disabled}>
        <legend className="sensor-lab-sr-only">{t.calibration}</legend>
        <label className="sensor-lab-check">
          <input
            type="checkbox"
            checked={draft.twoPoint}
            onChange={(event) => setField("twoPoint", event.currentTarget.checked)}
          />
          {t.twoPoint}
        </label>
        {draft.twoPoint && (
          <div className="sensor-lab-calibration-points">
            {fields.map((field) => (
              <div key={field}>
                <label className="sensor-lab-field" htmlFor={`${id}-${field}`}>
                  {fieldLabels[field]}
                  <input
                    id={`${id}-${field}`}
                    type="text"
                    inputMode="decimal"
                    value={draft[field]}
                    onChange={(event) => setField(field, event.currentTarget.value)}
                    aria-invalid={!valid}
                  />
                </label>
                {(field === "sourceA" || field === "sourceB") && (
                  <button
                    disabled={raw === null}
                    aria-label={`${t.capture} ${field === "sourceA" ? "A" : "B"}`}
                    onClick={() =>
                      isFreshMonitorReading(monitor) && raw !== null && setField(field, String(raw))
                    }
                  >
                    {t.capture}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <label className="sensor-lab-field">
          {t.unit}
          <input
            value={draft.unit}
            maxLength={20}
            onChange={(event) => setField("unit", event.currentTarget.value)}
          />
        </label>
        <div className="sensor-lab-actions">
          <button
            disabled={!valid || raw === null}
            onClick={() => {
              if (!calibration || raw === null || !isFreshMonitorReading(monitor)) return;
              const offset = calibrate(raw, { ...calibration, zeroOffset: 0 });
              if (offset !== null) setField("zeroOffset", String(offset));
            }}
          >
            {t.zero}
          </button>
          <button onClick={() => setField("zeroOffset", "0")}>{t.resetZero}</button>
        </div>
        <p className="sensor-lab-hint">
          {t.zeroOffset}: {draft.zeroOffset}
        </p>
        {!valid && (
          <p className="sensor-lab-error" role="alert">
            {calibration && validateCalibration(calibration) === "invalidUnit"
              ? t.invalidUnit
              : t.invalid}
          </p>
        )}
        <p className="sensor-lab-preview">
          {t.result}:{" "}
          <strong>
            {result === null ? t.noValue : chartNumber(result)} {draft.unit}
          </strong>
        </p>
        <div className="sensor-lab-actions">
          <button
            disabled={!valid}
            onClick={() => calibration && controller.setCalibration(channel.source.id, calibration)}
          >
            {t.apply}
          </button>
          <button
            onClick={() =>
              controller.setCalibration(channel.source.id, identityCalibration(channel.source.unit))
            }
          >
            {t.resetCalibration}
          </button>
        </div>
      </fieldset>
      <details>
        <summary>{t.code}</summary>
        <pre tabIndex={0} className="sensor-lab-code">
          {code || (valid ? t.codeUnavailable : t.invalid)}
        </pre>
        <button
          disabled={!code}
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            })();
          }}
        >
          {copied ? t.copied : t.copy}
        </button>
        {copyError && (
          <p className="sensor-lab-error" role="alert">
            {t.copyError}
          </p>
        )}
      </details>
      <details>
        <summary>{t.savedProfiles}</summary>
        <label className="sensor-lab-field">
          {t.profileName}
          <input
            disabled={disabled}
            value={profileName}
            maxLength={100}
            placeholder={t.profileDefault}
            onChange={(event) => setProfileName(event.currentTarget.value)}
          />
        </label>
        <button
          disabled={disabled || !valid}
          onClick={() =>
            calibration &&
            void controller.saveProfile(profileName.trim() || t.profileDefault, {
              source: channel.source,
              calibration,
            })
          }
        >
          {t.saveProfile}
        </button>
        {!profiles.length && <p className="sensor-lab-hint">{t.noProfiles}</p>}
        <ul className="sensor-lab-history">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <strong>{profile.name}</strong>
              <div className="sensor-lab-actions">
                <button
                  disabled={disabled}
                  onClick={() => controller.applyProfile(profile, channel.source.id)}
                >
                  {t.useProfile}
                </button>
                <button disabled={disabled} onClick={() => setDeleteProfile(profile.id)}>
                  {t.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </details>
      {deleteProfile && (
        <Dialog
          title={t.deleteProfileTitle}
          role="alertdialog"
          onClose={() => {
            if (!state.busy) setDeleteProfile(undefined);
          }}
        >
          <DialogActions>
            <button
              data-modal-initial
              disabled={state.busy}
              onClick={() => setDeleteProfile(undefined)}
            >
              {t.cancel}
            </button>
            <button
              className="danger"
              disabled={state.busy}
              onClick={() =>
                void controller.deleteProfile(deleteProfile).then((ok) => {
                  if (ok) setDeleteProfile(undefined);
                })
              }
            >
              {t.remove}
            </button>
          </DialogActions>
          {state.error && (
            <p className="sensor-lab-error" role="alert">
              {state.error}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

function calibrationDraft(calibration: SensorCalibration) {
  return {
    twoPoint: calibration.twoPoint,
    sourceA: String(calibration.sourceA),
    sourceB: String(calibration.sourceB),
    targetA: String(calibration.targetA),
    targetB: String(calibration.targetB),
    zeroOffset: String(calibration.zeroOffset),
    unit: calibration.unit,
  };
}
export function parseCalibrationDraft(
  draft: ReturnType<typeof calibrationDraft>,
): SensorCalibration | undefined {
  const keys = ["sourceA", "sourceB", "targetA", "targetB", "zeroOffset"] as const;
  if (keys.some((key) => !draft[key].trim() || !Number.isFinite(Number(draft[key]))))
    return undefined;
  return {
    twoPoint: draft.twoPoint,
    sourceA: Number(draft.sourceA),
    sourceB: Number(draft.sourceB),
    targetA: Number(draft.targetA),
    targetB: Number(draft.targetB),
    zeroOffset: Number(draft.zeroOffset),
    unit: draft.unit,
  };
}
