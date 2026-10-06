import { useEffect, useState } from "react";
import { motorTestActive, type MotorTestState } from "../../shared/motor-test.js";
import type { Locale } from "../i18n/copy.js";
import { Segmented } from "../components/segmented.js";
import type { MotorTestController, MotorTestOptions } from "./motor-test-controller.js";

export const motorLabels = {
  en: {
    test: "Test",
    collapse: "Close test",
    title: "Motor test",
    power: "Power",
    direction: "Direction",
    forward: "Forward",
    reverse: "Reverse",
    stopMode: "On finish",
    brake: "Brake",
    coast: "Coast",
    mode: "Movement",
    jog: "Jog",
    timed: "Timed",
    angle: "Angle",
    seconds: "Duration (s)",
    degrees: "Angle (°)",
    jogForward: "Hold forward",
    jogReverse: "Hold reverse",
    jogHint: "Release to stop · Space or Enter also works while focused.",
    start: "Start test",
    stop: "Stop",
    displacement: "Displacement",
    elapsed: "Elapsed",
    limit: "limit",
    powerError: "Enter a whole number from 1 to 100.",
    secondsError: "Enter 0.1 to 5 seconds.",
    degreesError: "Enter a whole number from 1 to 3,600.",
    hint: "Local motor only · jogging and angle tests stop after 10 seconds.",
    unavailable: "A current reading, an idle EV3 and no active recording are required.",
    reasonLocked: "The EV3 is busy with another device task.",
    reasonRecording: "Stop the Sensor Lab recording to test motors.",
    reasonProgram: "Stop the EV3 user program to test motors.",
    reasonStale: "Waiting for a current EV3 reading…",
    reasonUnsupported: "Only EV3 large and medium motors can be tested.",
    paused: "Motor test · other readings paused",
    fresh: "Angle",
    stale: "Last angle",
    program: "Motor test in progress",
    idle: "Ready",
    preparing: "Preparing…",
    running: "Running",
    stopping: "Stopping…",
    completed: "Completed",
    stopped: "Stopped",
    timeout: "Timed out",
    failed: "Test failed",
    unconfirmed: "Stop not confirmed",
    noReading: "No reading",
  },
  "zh-TW": {
    test: "測試",
    collapse: "收合測試",
    title: "馬達測試",
    power: "功率",
    direction: "方向",
    forward: "正向",
    reverse: "反向",
    stopMode: "結束方式",
    brake: "煞車",
    coast: "滑行",
    mode: "動作",
    jog: "點動",
    timed: "定時",
    angle: "角度",
    seconds: "時間（秒）",
    degrees: "角度（度）",
    jogForward: "按住正向",
    jogReverse: "按住反向",
    jogHint: "放開即停止 · 取得焦點後也可按住 Space／Enter。",
    start: "開始測試",
    stop: "停止",
    displacement: "本次位移",
    elapsed: "經過時間",
    limit: "上限",
    powerError: "請輸入 1–100 的整數。",
    secondsError: "請輸入 0.1–5 秒。",
    degreesError: "請輸入 1–3,600 的整數。",
    hint: "僅控制本機馬達 · 點動與角度測試最長 10 秒。",
    unavailable: "需取得最新讀值、等待 EV3 閒置並停止記錄，才能開始測試。",
    reasonLocked: "EV3 正在執行其他設備作業。",
    reasonRecording: "請先停止 Sensor Lab 記錄，才能測試馬達。",
    reasonProgram: "請先停止 EV3 使用者程式，才能測試馬達。",
    reasonStale: "等待 EV3 最新讀值…",
    reasonUnsupported: "僅支援 EV3 大型與中型馬達。",
    paused: "馬達測試中 · 其他讀值已暫停",
    fresh: "角度",
    stale: "最後角度",
    program: "馬達測試中",
    idle: "準備就緒",
    preparing: "準備中…",
    running: "運轉中",
    stopping: "停止中…",
    completed: "已完成",
    stopped: "已停止",
    timeout: "已逾時",
    failed: "測試失敗",
    unconfirmed: "停止未確認",
    noReading: "無讀值",
  },
};
type MotorLabels = (typeof motorLabels)[Locale];
type Mode = MotorTestOptions["mode"];
const jogLimitMs = 10_000;

export function motorTestNumbers(
  power: string,
  seconds: string,
  degrees: string,
): { power: number; durationMs: number; degrees: number } | undefined {
  if (![power, seconds, degrees].every((value) => value.trim())) return undefined;
  const values = {
    power: Number(power),
    durationMs: Math.round(Number(seconds) * 1_000),
    degrees: Number(degrees),
  };
  if (
    !Number.isInteger(values.power) ||
    values.power < 1 ||
    values.power > 100 ||
    !Number.isFinite(values.durationMs) ||
    Number(seconds) < 0.1 ||
    Number(seconds) > 5 ||
    !Number.isInteger(values.degrees) ||
    values.degrees < 1 ||
    values.degrees > 3_600
  )
    return undefined;
  return values;
}
/** "empty" blocks starting without shouting; "range" is shown next to the field. */
export type MotorFieldError = "empty" | "range";
export function motorFieldErrors(
  mode: Mode,
  power: string,
  seconds: string,
  degrees: string,
): Record<"power" | "seconds" | "degrees", MotorFieldError | undefined> {
  const check = (value: string, valid: (number: number) => boolean) =>
    !value.trim() ? "empty" : valid(Number(value)) ? undefined : "range";
  const integer = (min: number, max: number) => (value: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  return {
    power: check(power, integer(1, 100)),
    seconds:
      mode === "timed"
        ? check(seconds, (value) => Number.isFinite(value) && value >= 0.1 && value <= 5)
        : undefined,
    degrees: mode === "angle" ? check(degrees, integer(1, 3_600)) : undefined,
  };
}
export function motorStopConfirmed(state: MotorTestState): boolean {
  return ["idle", "completed", "stopped", "timeout"].includes(state.phase);
}
/** Progress toward the test's own end condition (or the jog safety limit), 0–1. */
export function motorTestProgress(state: MotorTestState): number | undefined {
  const request = state.request;
  if (!request) return undefined;
  const ratio =
    request.mode === "timed" && request.durationMs
      ? state.elapsedMs / request.durationMs
      : request.mode === "angle" && request.degrees
        ? state.displacement === null
          ? 0
          : Math.abs(state.displacement) / request.degrees
        : state.elapsedMs / jogLimitMs;
  return Math.max(0, Math.min(1, ratio));
}
function progressCaption(state: MotorTestState, t: MotorLabels): string {
  const request = state.request!;
  const elapsed = (state.elapsedMs / 1_000).toFixed(1);
  if (request.mode === "timed")
    return `${elapsed} / ${((request.durationMs ?? 0) / 1_000).toFixed(1)} s`;
  if (request.mode === "angle")
    return `${Math.abs(state.displacement ?? 0).toFixed(0)}° / ${request.degrees}°`;
  return `${elapsed} s · ${t.limit} ${jogLimitMs / 1_000} s`;
}

export function MotorTestControls({
  controller,
  state,
  port,
  locale,
  canStart,
  blockedReason,
}: {
  controller: MotorTestController;
  state: MotorTestState;
  port: number;
  locale: Locale;
  canStart: boolean;
  blockedReason?: string;
}): React.JSX.Element {
  const t = motorLabels[locale];
  const [power, setPower] = useState(() => controller.getSettings(port).power);
  const [seconds, setSeconds] = useState(() => controller.getSettings(port).seconds);
  const [degrees, setDegrees] = useState(() => controller.getSettings(port).degrees);
  const [direction, setDirection] = useState<1 | -1>(() => controller.getSettings(port).direction);
  const [brake, setBrake] = useState(() => controller.getSettings(port).brake);
  const [mode, setMode] = useState<Mode>(() => controller.getSettings(port).mode);
  useEffect(() => {
    controller.saveSettings(port, { power, seconds, degrees, direction, brake, mode });
  }, [controller, port, power, seconds, degrees, direction, brake, mode]);
  const busy = motorTestActive(state);
  const own = state.request?.port === port;
  const errors = motorFieldErrors(mode, power, seconds, degrees);
  const values = motorTestNumbers(
    power,
    mode === "timed" ? seconds : "1",
    mode === "angle" ? degrees : "90",
  );
  const disabled = busy || !canStart || !values;
  const start = (jogDirection: 1 | -1 = direction): void => {
    if (disabled || !values) return;
    void controller.start({
      port,
      power: values.power,
      direction: mode === "jog" ? jogDirection : direction,
      brake,
      mode,
      ...(mode === "timed" ? { durationMs: values.durationMs } : {}),
      ...(mode === "angle" ? { degrees: values.degrees } : {}),
    });
  };
  const stop = (): void => {
    void controller.stop();
  };
  const status = own ? state.phase : "idle";
  const stoppable = own && (busy || state.phase === "unconfirmed");
  const number = (value: number | null): string =>
    value === null ? t.noReading : `${value.toFixed(0)}°`;
  const fresh =
    own && busy && state.updatedAt !== undefined && Date.now() - state.updatedAt < 1_500;
  const progress = own ? motorTestProgress(state) : undefined;
  const id = (name: string) => `motor-${name}-${port}`;
  const fieldError = (name: "power" | "seconds" | "degrees", message: string) =>
    errors[name] === "range" ? (
      <small id={id(`${name}-error`)} className="motor-test-field-error">
        {message}
      </small>
    ) : null;
  const numberInput = (
    name: "seconds" | "degrees",
    value: string,
    onChange: (value: string) => void,
    limits: { min: string; max: string; step: string },
  ) => (
    <input
      id={id(name)}
      data-testid={`motor-test-${name}`}
      type="number"
      inputMode="decimal"
      {...limits}
      value={value}
      aria-invalid={errors[name] === "range"}
      aria-describedby={errors[name] === "range" ? id(`${name}-error`) : undefined}
      onChange={(event) => onChange(event.target.value)}
    />
  );
  return (
    <div
      id={`motor-test-${port}`}
      className="motor-test-controls"
      data-testid={`motor-test-${port}`}
      data-mode={mode}
    >
      <fieldset className="motor-test-fields" disabled={busy}>
        <legend className="sr-only">{t.title}</legend>
        <div className="motor-test-field motor-test-wide">
          <span id={id("mode-label")}>{t.mode}</span>
          <Segmented<Mode>
            id={id("mode")}
            labelledBy={id("mode-label")}
            disabled={busy}
            value={mode}
            onChange={setMode}
            options={[
              { value: "jog", label: t.jog },
              { value: "timed", label: t.timed },
              { value: "angle", label: t.angle },
            ]}
          />
        </div>
        <div className="motor-test-field motor-test-wide">
          <div className="motor-test-power-heading">
            <label htmlFor={id("power")}>{t.power}</label>
            <span className="motor-test-number">
              <input
                id={id("power")}
                data-testid="motor-test-power"
                type="number"
                inputMode="numeric"
                min="1"
                max="100"
                step="1"
                value={power}
                aria-invalid={errors.power === "range"}
                aria-describedby={errors.power === "range" ? id("power-error") : undefined}
                onChange={(event) => setPower(event.target.value)}
              />
              <span aria-hidden="true">%</span>
            </span>
          </div>
          <input
            className="motor-test-slider"
            type="range"
            min="1"
            max="100"
            step="1"
            tabIndex={-1}
            aria-hidden="true"
            value={Math.max(1, Math.min(100, Math.round(Number(power)) || 1))}
            onChange={(event) => setPower(event.target.value)}
          />
          {fieldError("power", t.powerError)}
        </div>
        {mode !== "jog" && (
          <div className="motor-test-field">
            <span id={id("direction-label")}>{t.direction}</span>
            <Segmented<1 | -1>
              id={id("direction")}
              labelledBy={id("direction-label")}
              disabled={busy}
              value={direction}
              onChange={setDirection}
              options={[
                { value: 1, label: t.forward },
                { value: -1, label: t.reverse },
              ]}
            />
          </div>
        )}
        <div className="motor-test-field">
          <span id={id("brake-label")}>{t.stopMode}</span>
          <Segmented
            id={id("brake")}
            labelledBy={id("brake-label")}
            disabled={busy}
            value={brake ? "brake" : "coast"}
            onChange={(value) => setBrake(value === "brake")}
            options={[
              { value: "brake", label: t.brake },
              { value: "coast", label: t.coast },
            ]}
          />
        </div>
        {mode === "timed" && (
          <div className="motor-test-field">
            <label htmlFor={id("seconds")}>{t.seconds}</label>
            {numberInput("seconds", seconds, setSeconds, { min: "0.1", max: "5", step: "0.1" })}
            {fieldError("seconds", t.secondsError)}
          </div>
        )}
        {mode === "angle" && (
          <div className="motor-test-field">
            <label htmlFor={id("degrees")}>{t.degrees}</label>
            {numberInput("degrees", degrees, setDegrees, { min: "1", max: "3600", step: "1" })}
            {fieldError("degrees", t.degreesError)}
          </div>
        )}
      </fieldset>
      {mode === "jog" ? (
        <div className="motor-test-jogs">
          <JogButton
            testId="motor-test-jog-reverse"
            direction={-1}
            label={t.jogReverse}
            {...{ controller, state, port, start }}
            disabled={disabled}
          />
          <JogButton
            testId="motor-test-jog"
            direction={1}
            label={t.jogForward}
            {...{ controller, state, port, start }}
            disabled={disabled}
          />
        </div>
      ) : (
        // One element for start and stop keeps keyboard focus on the action while it runs.
        <button
          className={`motor-test-action ${stoppable ? "danger" : "primary"}`}
          data-testid={stoppable ? "motor-test-stop" : "motor-test-start"}
          disabled={!stoppable && disabled}
          onClick={stoppable ? stop : () => start()}
        >
          {stoppable ? t.stop : t.start}
        </button>
      )}
      {mode === "jog" && stoppable && state.phase === "unconfirmed" && (
        <button className="motor-test-action danger" data-testid="motor-test-stop" onClick={stop}>
          {t.stop}
        </button>
      )}
      {!canStart && !busy && <p className="motor-test-blocked">{blockedReason || t.unavailable}</p>}
      <div className="motor-test-status-card" data-state={status}>
        <div className="motor-test-status-row">
          <span
            className="motor-test-status"
            data-testid="motor-test-status"
            data-state={status}
            role="status"
          >
            <span className="motor-test-status-dot" aria-hidden="true" />
            {t[status]}
          </span>
          {progress !== undefined && (
            <span className="motor-test-progress-caption">{progressCaption(state, t)}</span>
          )}
        </div>
        {progress !== undefined && (
          <div
            className="motor-test-progress"
            role="progressbar"
            aria-label={t.elapsed}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {own && (
          <dl className="monitor-values motor-test-values" data-fresh={fresh}>
            <div>
              <dt>{fresh ? t.fresh : t.stale}</dt>
              <dd>{number(state.angle)}</dd>
            </div>
            <div>
              <dt>{t.displacement}</dt>
              <dd>{number(state.displacement)}</dd>
            </div>
          </dl>
        )}
        {own && state.message && (
          <p className="monitor-error" role="alert">
            {state.message}
          </p>
        )}
      </div>
      <p className="monitor-hint motor-test-hint">{mode === "jog" ? t.jogHint : t.hint}</p>
    </div>
  );
}

function JogButton({
  testId,
  direction,
  label,
  controller,
  state,
  port,
  disabled,
  start,
}: {
  testId: string;
  direction: 1 | -1;
  label: string;
  controller: MotorTestController;
  state: MotorTestState;
  port: number;
  disabled: boolean;
  start(direction: 1 | -1): void;
}): React.JSX.Element {
  const busy = motorTestActive(state);
  const pressed =
    busy &&
    state.request?.port === port &&
    state.request.mode === "jog" &&
    state.request.direction === direction;
  const release = (): void => {
    if (controller.getSnapshot().request?.port === port) void controller.releaseJog();
  };
  return (
    <button
      className="motor-test-jog"
      data-testid={testId}
      data-direction={direction}
      disabled={disabled && !pressed}
      aria-pressed={pressed}
      onPointerDown={(event) => {
        if (event.button !== 0 || busy) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        start(direction);
      }}
      onPointerUp={release}
      onPointerCancel={() => {
        void controller.stop();
      }}
      onLostPointerCapture={release}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        if (!event.repeat) start(direction);
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          release();
        }
      }}
      onBlur={() => {
        if (
          controller.getSnapshot().request?.port === port &&
          motorTestActive(controller.getSnapshot())
        )
          void controller.stop();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void controller.stop();
      }}
    >
      {direction < 0 && <span aria-hidden="true">◀</span>}
      <span>{label}</span>
      {direction > 0 && <span aria-hidden="true">▶</span>}
    </button>
  );
}
