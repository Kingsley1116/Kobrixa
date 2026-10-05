import { useEffect, useSyncExternalStore } from "react";
import type { MonitorInput, MonitorOutput } from "@kobrixa/device";
import type { Locale } from "../i18n/copy.js";
import { Picker } from "../components/picker.js";
import type { MonitorController, MonitorState } from "./monitor-controller.js";

const labels = {
  en: {
    title: "Live EV3 monitor",
    battery: "Battery",
    voltage: "Voltage",
    program: "EV3 user program slot",
    stopped: "Stopped",
    running: "Running",
    unknown: "Unknown",
    live: "Live",
    paused: "Paused · last readings",
    waiting: "Waiting · readings may be stale",
    error: "Update failed · last readings",
    updated: "Last updated",
    inputs: "Inputs",
    outputs: "Outputs",
    input: "Input",
    output: "Output",
    empty: "Not connected",
    initializing: "Initializing",
    deviceError: "Device error",
    unavailable: "Unavailable",
    invalid: "Invalid reading",
    channel: "Channel",
    mode: "Mode",
    angle: "Angle",
    change: "Change mode",
    loading: "Loading modes…",
    switching: "Applying mode…",
    stopHint: "Stop the EV3 user program before changing sensor modes.",
    staleHint: "Mode changes require a current device status and an idle EV3.",
    connectHint: "Connect an EV3 to view its ports, battery and program status.",
    connect: "Connect EV3",
    localHint:
      "Local brick only. Program status refers to the EV3, including programs started on the brick.",
    current: "current",
    sensor: "Sensor",
    motor: "Motor",
    waitingSample: "Waiting for the first reading…",
    readOnly: "Read only",
    noModes: "No selectable modes",
    percent: "%",
  },
  "zh-TW": {
    title: "EV3 即時監測",
    battery: "電量",
    voltage: "電壓",
    program: "EV3 使用者程式槽",
    stopped: "已停止",
    running: "執行中",
    unknown: "未知",
    live: "即時",
    paused: "已暫停 · 最後讀值",
    waiting: "等待更新 · 讀值可能已過期",
    error: "更新失敗 · 最後讀值",
    updated: "最後更新",
    inputs: "輸入埠",
    outputs: "輸出埠",
    input: "輸入埠",
    output: "輸出埠",
    empty: "未連接",
    initializing: "初始化中",
    deviceError: "裝置錯誤",
    unavailable: "無資料",
    invalid: "讀值無效",
    channel: "通道",
    mode: "模式",
    angle: "角度",
    change: "切換模式",
    loading: "載入模式…",
    switching: "切換模式中…",
    stopHint: "請先停止 EV3 使用者程式，才能切換感測器模式。",
    staleHint: "需取得最新裝置狀態，並等待 EV3 閒置後才能切換模式。",
    connectHint: "連接 EV3，即可查看連接埠、電量與程式狀態。",
    connect: "連接 EV3",
    localHint: "僅監測本機 EV3。程式狀態包含從 EV3 本體啟動的程式。",
    current: "目前",
    sensor: "感測器",
    motor: "馬達",
    waitingSample: "等待第一筆讀值…",
    readOnly: "唯讀",
    noModes: "無可選模式",
    percent: "%",
  },
};
type Labels = (typeof labels)[Locale];
const deviceNames: Record<number, readonly [string, string]> = {
  7: ["EV3 大型馬達", "EV3 large motor"],
  8: ["EV3 中型馬達", "EV3 medium motor"],
  16: ["EV3 觸碰感測器", "EV3 touch sensor"],
  29: ["EV3 顏色感測器", "EV3 color sensor"],
  30: ["EV3 超音波感測器", "EV3 ultrasonic sensor"],
  32: ["EV3 陀螺儀", "EV3 gyro sensor"],
  33: ["EV3 紅外線感測器", "EV3 infrared sensor"],
};
function deviceName(value: MonitorInput | MonitorOutput, locale: Locale, t: Labels): string {
  if (value.state === "empty") return t.empty;
  return deviceNames[value.type]?.[locale === "zh-TW" ? 0 : 1] || value.name || t.unknown;
}
function reading(value: number | null | undefined, decimals: number, t: Labels): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? t.invalid
    : value.toFixed(Math.max(0, Math.min(6, decimals)));
}
function portState(state: MonitorInput["state"], t: Labels): string | undefined {
  return state === "ready"
    ? undefined
    : state === "error"
      ? t.deviceError
      : state === "empty"
        ? t.empty
        : t[state];
}

export function MonitorPanel({
  controller,
  locale,
  active,
  sessionId,
  locked = false,
  onConnect,
}: {
  controller: MonitorController;
  locale: Locale;
  active: boolean;
  sessionId: string | undefined;
  locked?: boolean;
  onConnect(): void;
}): React.JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const t = labels[locale];
  useEffect(() => {
    const configure = () => controller.configure(sessionId, active && !document.hidden);
    configure();
    document.addEventListener("visibilitychange", configure);
    return () => {
      document.removeEventListener("visibilitychange", configure);
      controller.configure(sessionId, false);
    };
  }, [controller, sessionId, active]);
  const snapshot = state.snapshot;
  return (
    <section
      className="monitor-panel"
      aria-label={t.title}
      data-testid="ev3-monitor"
      data-stale={state.status !== "live"}
    >
      <div
        className="monitor-status"
        data-testid="monitor-status"
        data-state={state.status}
        role="status"
      >
        <span className="monitor-status-dot" aria-hidden="true" />
        {t[state.status]}
      </div>
      {!sessionId && (
        <div className="monitor-connect">
          <p>{t.connectHint}</p>
          <button onClick={onConnect}>{t.connect}</button>
        </div>
      )}
      {state.error && (
        <p className="monitor-error" role="alert">
          {state.error}
        </p>
      )}
      {snapshot ? (
        <>
          <dl className="monitor-summary">
            <div>
              <dt>{t.battery}</dt>
              <dd data-testid="monitor-battery">
                {snapshot.battery.percent === null
                  ? t.unavailable
                  : `${snapshot.battery.percent}${t.percent}`}
              </dd>
            </div>
            <div>
              <dt>{t.voltage}</dt>
              <dd>
                {snapshot.battery.voltage === null
                  ? t.unavailable
                  : `${reading(snapshot.battery.voltage, 2, t)} V`}
              </dd>
            </div>
            <div className="monitor-program">
              <dt>{t.program}</dt>
              <dd data-testid="monitor-program" data-state={snapshot.program.status}>
                {t[snapshot.program.status]}
              </dd>
            </div>
          </dl>
          <p className="monitor-updated">
            {t.updated}{" "}
            <time
              data-testid="monitor-updated"
              dateTime={new Date(snapshot.sampledAt).toISOString()}
            >
              {new Date(snapshot.sampledAt).toLocaleTimeString(locale, { hour12: false })}
            </time>
          </p>
          <p className="monitor-hint">{t.localHint}</p>
          {snapshot.program.status !== "stopped" && <p className="monitor-hint">{t.stopHint}</p>}
          {state.modeError && (
            <p className="monitor-error" role="alert">
              {state.modeError}
            </p>
          )}
          <h3>{t.inputs}</h3>
          <div className="monitor-inputs">
            {snapshot.inputs.map((input) => (
              <InputCard
                key={input.port}
                input={input}
                locale={locale}
                state={state}
                controller={controller}
                locked={locked}
              />
            ))}
          </div>
          <h3>{t.outputs}</h3>
          <div className="monitor-outputs">
            {snapshot.outputs.map((output) => (
              <article
                className="monitor-port"
                key={output.port}
                data-testid={`monitor-output-${output.port}`}
              >
                <h4>
                  <span className="monitor-port-number">
                    {String.fromCharCode(65 + output.port)}
                  </span>
                  <span>{deviceName(output, locale, t)}</span>
                </h4>
                {portState(output.state, t) ? (
                  <p className="monitor-hint">{portState(output.state, t)}</p>
                ) : (
                  <p className="monitor-value">
                    <span>{t.angle}</span>
                    <strong>
                      {reading(output.angle, 0, t)}
                      {output.angle !== null ? "°" : ""}
                    </strong>
                  </p>
                )}
              </article>
            ))}
          </div>
        </>
      ) : (
        sessionId && <p className="monitor-hint">{t.waitingSample}</p>
      )}
    </section>
  );
}
function InputCard({
  input,
  locale,
  state,
  controller,
  locked,
}: {
  input: MonitorInput;
  locale: Locale;
  state: MonitorState;
  controller: MonitorController;
  locked: boolean;
}): React.JSX.Element {
  const t = labels[locale];
  const modes = state.modes[input.port];
  const disabled = locked || !controller.canSwitch(input.port);
  const reason = state.snapshot?.program.status !== "stopped" ? t.stopHint : t.staleHint;
  const busy = state.loadingPort === input.port || state.switchingPort === input.port;
  const title = `${t.input} ${input.port + 1} · ${t.mode}`;
  return (
    <article className="monitor-port" data-testid={`monitor-input-${input.port}`}>
      <h4>
        <span className="monitor-port-number">{input.port + 1}</span>
        <span>{deviceName(input, locale, t)}</span>
      </h4>
      {portState(input.state, t) ? (
        <p className="monitor-hint">{portState(input.state, t)}</p>
      ) : (
        <>
          <div className="monitor-mode">
            <span className="monitor-hint">
              {t.mode}: <span>{input.modeName || input.mode}</span>
            </span>
            {input.switchable ? (
              modes ? (
                <div className="monitor-mode-select">
                  <label htmlFor={`monitor-mode-${input.port}`}>{t.change}</label>
                  <Picker
                    id={`monitor-mode-${input.port}`}
                    label={title}
                    locale={locale}
                    disabled={disabled || !modes.modes.length}
                    title={disabled ? reason : title}
                    value={input.mode}
                    onChange={(mode) => {
                      void controller.setMode(input.port, mode);
                    }}
                    options={[
                      ...(!modes.modes.some((value) => value.mode === input.mode)
                        ? [
                            {
                              value: input.mode,
                              label: `${input.modeName || input.mode} (${t.current})`,
                              disabled: true,
                            },
                          ]
                        : []),
                      ...modes.modes.map((value) => ({
                        value: value.mode,
                        label: value.name || String(value.mode),
                      })),
                    ]}
                  />
                  {!modes.modes.length && <span>{t.noModes}</span>}
                </div>
              ) : (
                <button
                  className="monitor-mode-button"
                  data-testid={`monitor-load-modes-${input.port}`}
                  aria-label={`${t.change} · ${t.input} ${input.port + 1}`}
                  disabled={disabled}
                  title={disabled ? reason : title}
                  onClick={() => {
                    void controller.loadModes(input.port);
                  }}
                >
                  {state.loadingPort === input.port ? t.loading : t.change}
                </button>
              )
            ) : (
              <span className="monitor-hint">{t.readOnly}</span>
            )}
          </div>
          {busy && (
            <p className="monitor-hint" role="status">
              {state.switchingPort === input.port ? t.switching : t.loading}
            </p>
          )}
          <dl className="monitor-values">
            {input.values.length ? (
              input.values.map((value, index) => (
                <div key={index}>
                  <dt>
                    {t.channel} {index + 1}
                  </dt>
                  <dd>
                    {reading(value, input.decimals, t)}
                    {value !== null && Number.isFinite(value) && input.unit ? (
                      <span className="monitor-unit"> {input.unit}</span>
                    ) : null}
                  </dd>
                </div>
              ))
            ) : (
              <div>
                <dt>{t.channel} 1</dt>
                <dd>{t.invalid}</dd>
              </div>
            )}
          </dl>
        </>
      )}
    </article>
  );
}
