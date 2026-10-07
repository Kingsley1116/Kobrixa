import { useCallback, useEffect, useRef, useState } from "react";
import type { KobrixaIR, SourceSpan } from "@kobrixa/ir";
import type { PreviewSnapshot } from "../../preview/runtime.js";
import type {
  PreviewButton,
  PreviewInputs,
  PreviewSensor,
  PreviewValue,
} from "../../preview/virtual-device.js";
import { Dialog } from "../components/dialog.js";
import { previewCopy } from "./preview-copy.js";
import { previewSpeeds, type PreviewCommand, type PreviewResponse } from "./protocol.js";
import "./preview.css";

type Locale = keyof typeof previewCopy;
type Copy = (typeof previewCopy)[Locale];
type Port = 1 | 2 | 3 | 4;
const ports = [1, 2, 3, 4] as const;
const buttons: PreviewButton[] = ["up", "left", "enter", "right", "down", "back"];
const glyphs: Record<PreviewButton, string> = {
  up: "▲",
  down: "▼",
  left: "◀",
  right: "▶",
  enter: "●",
  back: "↶",
};
const keyButtons: Record<string, PreviewButton> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Backspace: "back",
};

export function parsePreviewValues(text: string): number[] | undefined {
  const parts = text.split(",");
  if (parts.length > 8 || !parts.length || parts.some((part) => !part.trim())) return undefined;
  const values = parts.map(Number);
  return values.every(Number.isFinite) ? values : undefined;
}

/** Preserve numerical state that JSON would silently turn into null or positive zero. */
export function formatPreviewValue(value: PreviewValue): string {
  const render = (entry: PreviewValue): string => {
    if (Array.isArray(entry)) return `[${entry.map(render).join(", ")}]`;
    if (typeof entry === "number") return Object.is(entry, -0) ? "-0" : String(entry);
    return JSON.stringify(entry);
  };
  const text = render(value);
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

export interface OfflinePreviewProps {
  ir: KobrixaIR;
  files?: Record<string, number[]>;
  locale: Locale;
  projectName: string;
  onClose(): void;
  onSource?(span: SourceSpan): void;
  onRestartBuild?(): void;
}

export function OfflinePreview({
  ir,
  files,
  locale,
  projectName,
  onClose,
  onSource,
  onRestartBuild,
}: OfflinePreviewProps): React.JSX.Element {
  const t = previewCopy[locale];
  const worker = useRef<Worker | null>(null);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [held, setHeld] = useState<PreviewButton[]>([]);
  const heldRef = useRef(new Set<PreviewButton>());
  const post = useCallback((command: PreviewCommand) => worker.current?.postMessage(command), []);
  const releaseAll = useCallback(() => {
    heldRef.current.clear();
    setHeld([]);
    post({ type: "inputs", inputs: { buttons: [] } });
  }, [post]);
  useEffect(() => {
    let active = true;
    let instance: Worker | null = null;
    setSnapshot(null);
    setError(null);
    setSpeed(1);
    heldRef.current.clear();
    setHeld([]);
    try {
      instance = new Worker(new URL("./preview-worker.ts", import.meta.url), { type: "module" });
      worker.current = instance;
      instance.onmessage = (event: MessageEvent<PreviewResponse>) => {
        if (!active) return;
        if (event.data.type === "snapshot") setSnapshot(event.data.snapshot);
        else setError(event.data.message);
      };
      instance.onerror = (event) => {
        if (active) setError(event.message || "Could not start the preview worker.");
      };
      instance.onmessageerror = () => {
        if (active) setError("Could not read the preview worker response.");
      };
      instance.postMessage({
        type: "load",
        ir,
        ...(files ? { files } : {}),
      } satisfies PreviewCommand);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    const hidden = () => {
      if (document.hidden) {
        releaseAll();
        post({ type: "pause" });
      }
    };
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      active = false;
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", hidden);
      instance?.terminate();
      if (worker.current === instance) worker.current = null;
    };
  }, [ir, files, post, releaseAll]);

  const input = (inputs: PreviewInputs) => post({ type: "inputs", inputs });
  const button = (name: PreviewButton, pressed: boolean) => {
    if (pressed) heldRef.current.add(name);
    else heldRef.current.delete(name);
    const next = [...heldRef.current];
    setHeld(next);
    input({ buttons: next });
  };
  const status = snapshot?.status;
  const terminal = status === "stopped" || status === "completed" || status === "error";
  const running = status === "running";
  const span = snapshot?.error?.span ?? snapshot?.currentSpan;
  const device = snapshot?.device;
  const reset = () => {
    releaseAll();
    setError(null);
    post({
      type: "load",
      ir,
      ...(files ? { files } : {}),
      ...(device
        ? { inputs: { sensors: device.sensors, batteryLevel: device.batteryLevel, buttons: [] } }
        : {}),
    });
  };
  return (
    <Dialog
      title={`${t.title} · ${projectName}`}
      onClose={onClose}
      className="offline-preview"
      descriptionId="preview-disclosure"
    >
      <div className="preview-toolbar" aria-label={t.title}>
        <button
          data-modal-initial
          data-testid="preview-run"
          className="primary"
          disabled={!snapshot || terminal || !!error}
          title={t.runHint}
          onClick={() => post({ type: running ? "pause" : "run" })}
        >
          {running ? t.pause : t.run}
        </button>
        <button
          data-testid="preview-step"
          disabled={!snapshot || running || terminal || !!error}
          title={t.stepHint}
          onClick={() => post({ type: "step" })}
        >
          {t.step}
        </button>
        <button
          data-testid="preview-stop"
          disabled={!snapshot || terminal}
          onClick={() => {
            releaseAll();
            post({ type: "stop" });
          }}
        >
          {t.stop}
        </button>
        <button
          data-testid="preview-reset"
          disabled={!worker.current}
          title={t.resetHint}
          onClick={reset}
        >
          {t.reset}
        </button>
        {onRestartBuild && (
          <button
            onClick={() => {
              releaseAll();
              post({ type: "pause" });
              onRestartBuild();
            }}
          >
            {t.rebuild}
          </button>
        )}
        <label className="preview-speed">
          {t.speed}
          <select
            aria-label={t.speed}
            value={speed}
            onChange={(event) => {
              const value = Number(event.target.value);
              setSpeed(value);
              post({ type: "speed", value });
            }}
          >
            {previewSpeeds.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <button className="preview-close" aria-label={t.close} onClick={onClose}>
          {t.close}
        </button>
      </div>
      <div className="preview-scroll">
        <div className="preview-status-row">
          <span role="status" className="preview-status" data-state={error ? "error" : status}>
            {error ? t.error : status ? t[status] : t.loading}
          </span>
          <span>
            {t.elapsed}: {((snapshot?.elapsedMs ?? 0) / 1000).toFixed(2)} s
          </span>
          <span>
            {t.instructions}: {snapshot?.instructions ?? 0}
          </span>
          <span>
            {t.threads}: {snapshot?.threadCount ?? 0}
          </span>
        </div>
        {(error || snapshot?.error) && (
          <div role="alert" className="preview-error">
            <strong>{t.error}</strong>
            <p>{error ?? snapshot?.error?.message}</p>
            {span && onSource && <button onClick={() => onSource(span)}>{t.source}</button>}
          </div>
        )}
        <div className="preview-grid">
          <section className="preview-device" aria-label={t.virtual}>
            <div className="preview-brick">
              <div className="preview-brick-heading">
                <strong>{t.virtual}</strong>
                <span>178 × 128</span>
              </div>
              <PreviewLcd lcd={device?.lcd} label={t.lcd} />
              <div className="preview-indicators">
                <span>
                  {t.led}:{" "}
                  <i
                    className="preview-led"
                    data-color={device?.led.color ?? "off"}
                    data-effect={device?.led.effect ?? "off"}
                  />{" "}
                  {device?.led.color ?? "off"} {device?.led.effect ?? ""}
                </span>
                <span>
                  {t.sound}:{" "}
                  {device?.speaker.busy
                    ? `${device.speaker.frequency} Hz · ${device.speaker.volume}%`
                    : t.silent}
                </span>
              </div>
              <div
                className="preview-button-pad"
                role="group"
                aria-label={t.buttons}
                aria-describedby="preview-button-hint"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    releaseAll();
                }}
                onKeyDown={(event) => {
                  const target = event.target as HTMLElement;
                  const name =
                    keyButtons[event.key] ??
                    (event.key === "Enter" || event.key === " "
                      ? ((target.dataset.previewButton as PreviewButton | undefined) ?? "enter")
                      : undefined);
                  if (!name) return;
                  event.preventDefault();
                  if (!event.repeat) button(name, true);
                }}
                onKeyUp={(event) => {
                  const target = event.target as HTMLElement;
                  const name =
                    keyButtons[event.key] ??
                    (event.key === "Enter" || event.key === " "
                      ? ((target.dataset.previewButton as PreviewButton | undefined) ?? "enter")
                      : undefined);
                  if (!name) return;
                  event.preventDefault();
                  button(name, false);
                }}
              >
                {buttons.map((name) => (
                  <button
                    key={name}
                    data-preview-button={name}
                    className={`preview-button preview-button-${name}`}
                    aria-label={t[name]}
                    aria-pressed={held.includes(name)}
                    title={t[name]}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.focus();
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      button(name, true);
                    }}
                    onBlur={releaseAll}
                    onPointerUp={() => button(name, false)}
                    onPointerCancel={() => button(name, false)}
                    onLostPointerCapture={() => button(name, false)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      releaseAll();
                    }}
                  >
                    <span aria-hidden="true">{glyphs[name]}</span>
                    <span className="sr-only">{t[name]}</span>
                  </button>
                ))}
              </div>
              <p id="preview-button-hint" className="preview-hint">
                {t.buttonsHint}
              </p>
            </div>
            <div className="preview-section">
              <h3>{t.motors}</h3>
              <div className="preview-motors">
                {(["A", "B", "C", "D"] as const).map((port) => {
                  const motor = device?.motors[port];
                  return (
                    <div className="preview-motor" key={port} data-busy={motor?.busy ?? false}>
                      <div>
                        <strong>{port}</strong>
                        <span>{motor?.busy ? t.active : t.idle}</span>
                      </div>
                      <progress
                        aria-label={`${port} ${t.power}`}
                        max={100}
                        value={Math.abs(motor?.speed ?? 0)}
                      />
                      <span>
                        {t.power}: {(motor?.speed ?? 0).toFixed(0)}%
                      </span>
                      <span>
                        {t.count}: {(motor?.count ?? 0).toFixed(1)}°
                      </span>
                      <small>{motor?.brake ? t.braking : t.coasting}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
          <section
            className="preview-section preview-sensors"
            aria-labelledby="preview-sensors-title"
          >
            <h3 id="preview-sensors-title">{t.inputs}</h3>
            <p className="preview-hint">{t.sensorHint}</p>
            {device &&
              ports.map((port) => (
                <SensorInput
                  key={port}
                  port={port}
                  sensor={device.sensors[port]}
                  t={t}
                  update={(sensor) => input({ sensors: { [port]: sensor } })}
                />
              ))}
            <label className="preview-battery">
              {t.battery}: {device?.batteryLevel ?? 100}%
              <input
                aria-label={t.battery}
                type="range"
                min="0"
                max="100"
                value={device?.batteryLevel ?? 100}
                onChange={(event) => input({ batteryLevel: Number(event.target.value) })}
              />
            </label>
          </section>
          <section
            className="preview-section preview-inspector"
            aria-labelledby="preview-inspector-title"
          >
            <h3 id="preview-inspector-title">{t.inspect}</h3>
            <h4>{t.location}</h4>
            <p className="preview-location">
              {span ? `${span.file}:${span.start.line}:${span.start.column}` : t.noLocation}
            </p>
            {span && onSource && <button onClick={() => onSource(span)}>{t.source}</button>}
            <ol className="preview-call-stack">
              {snapshot?.callStack.map((frame, index) => (
                <li key={`${index}-${frame}`}>{frame}</li>
              ))}
            </ol>
            {((snapshot?.truncatedVariables?.length ?? 0) > 0 ||
              (snapshot?.omittedVariableCount ?? 0) > 0) && (
              <p className="preview-hint">{t.shortenedVariables}</p>
            )}
            <h4>{t.variables}</h4>
            <div className="preview-variable-scroll">
              <table className="preview-variables">
                <tbody>
                  {Object.entries(snapshot?.globals ?? {}).map(([name, value]) => (
                    <tr key={name}>
                      <th scope="row">{name}</th>
                      <td>
                        <code>{formatPreviewValue(value)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!Object.keys(snapshot?.globals ?? {}).length && (
                <p className="preview-hint">{t.empty}</p>
              )}
            </div>
            <h4>{t.locals}</h4>
            <div className="preview-variable-scroll">
              <table className="preview-variables">
                <tbody>
                  {Object.entries(snapshot?.locals ?? {}).map(([name, value]) => (
                    <tr key={name}>
                      <th scope="row">{name}</th>
                      <td>
                        <code>{formatPreviewValue(value)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!Object.keys(snapshot?.locals ?? {}).length && (
                <p className="preview-hint">{t.empty}</p>
              )}
            </div>
            <details>
              <summary>
                {t.files} ({device?.files.length ?? 0})
              </summary>
              <ul className="preview-files">
                {device?.files.map((file) => (
                  <li key={file.path}>
                    {file.path} · {file.size} B
                  </li>
                ))}
              </ul>
            </details>
          </section>
          <section
            className="preview-section preview-events"
            aria-labelledby="preview-events-title"
          >
            <div className="preview-section-heading">
              <h3 id="preview-events-title">{t.events}</h3>
              <small>{t.logHint}</small>
            </div>
            <div className="preview-event-scroll" tabIndex={0} role="region" aria-label={t.events}>
              {device?.events.length ? (
                <table>
                  <tbody>
                    {[...device.events].reverse().map((event) => (
                      <tr key={event.id}>
                        <td>{(event.timeMs / 1000).toFixed(2)} s</td>
                        <th scope="row">{event.operation}</th>
                        <td>{event.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="preview-hint">{t.empty}</p>
              )}
            </div>
          </section>
        </div>
        <footer className="preview-disclosure" id="preview-disclosure">
          <p>{t.disclosure}</p>
          <p>{t.assets}</p>
        </footer>
      </div>
    </Dialog>
  );
}

function PreviewLcd({
  lcd,
  label,
}: {
  lcd: PreviewSnapshot["device"]["lcd"] | undefined;
  label: string;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!lcd || !canvas.current) return;
    const context = canvas.current.getContext("2d");
    if (!context) return;
    const image = context.createImageData(lcd.width, lcd.height);
    for (let index = 0; index < lcd.width * lcd.height; index++) {
      const shade = lcd.pixels[index] ? 25 : 212;
      image.data[index * 4] = shade;
      image.data[index * 4 + 1] = lcd.pixels[index] ? 35 : 223;
      image.data[index * 4 + 2] = lcd.pixels[index] ? 24 : 189;
      image.data[index * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [lcd]);
  return (
    <canvas
      ref={canvas}
      width="178"
      height="128"
      role="img"
      aria-label={label}
      className="preview-lcd"
    />
  );
}

function NumberInput({
  value,
  label,
  min,
  max,
  integer = false,
  onChange,
  t,
}: {
  value: number;
  label: string;
  min: number;
  max: number;
  integer?: boolean;
  onChange(value: number): void;
  t: Copy;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const number = Number(draft);
  const valid =
    draft.trim() !== "" &&
    Number.isFinite(number) &&
    number >= min &&
    number <= max &&
    (!integer || Number.isInteger(number));
  return (
    <label>
      {label}
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={integer ? 1 : "any"}
        aria-label={label}
        aria-invalid={!valid}
        title={`${min} – ${max}`}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number(next);
          if (
            next.trim() &&
            Number.isFinite(parsed) &&
            parsed >= min &&
            parsed <= max &&
            (!integer || Number.isInteger(parsed))
          )
            onChange(parsed);
        }}
      />
      {!valid && <small className="preview-input-error">{t.numberError}</small>}
    </label>
  );
}

function ValuesInput({
  values,
  label,
  onChange,
  t,
}: {
  values: number[];
  label: string;
  onChange(values: number[]): void;
  t: Copy;
}): React.JSX.Element {
  const serialized = values.join(", ");
  const [draft, setDraft] = useState(serialized);
  useEffect(() => setDraft(serialized), [serialized]);
  const parsed = parsePreviewValues(draft);
  return (
    <label>
      {label}
      <input
        value={draft}
        aria-label={label}
        aria-invalid={!parsed}
        title={t.valuesHint}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = parsePreviewValues(event.target.value);
          if (next) onChange(next);
        }}
      />
      {!parsed && <small className="preview-input-error">{t.valueError}</small>}
    </label>
  );
}

function SensorInput({
  port,
  sensor,
  t,
  update,
}: {
  port: Port;
  sensor: PreviewSensor;
  t: Copy;
  update(value: Partial<PreviewSensor>): void;
}): React.JSX.Element {
  const presets = [
    { type: 0, label: t.noSensor, name: "NONE" },
    { type: 16, label: t.touch, name: "EV3-TOUCH" },
    { type: 29, label: t.color, name: "EV3-COLOR" },
    { type: 30, label: t.ultrasonic, name: "EV3-US" },
    { type: 32, label: t.gyro, name: "EV3-GYRO" },
    { type: 33, label: t.infrared, name: "EV3-IR" },
  ];
  const prefix = `${t.port} ${port}`;
  const [expanded, setExpanded] = useState(port === 1);
  return (
    <details
      className="preview-sensor"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <strong>{prefix}</strong>
        <span>
          {presets.find((preset) => preset.type === sensor.type)?.label ?? t.custom} · {t.mode}{" "}
          {sensor.mode}
        </span>
      </summary>
      <fieldset className="preview-sensor-content">
        <legend className="sr-only">{prefix}</legend>
        <div className="preview-sensor-fields">
          <label>
            {t.type}
            <select
              aria-label={`${prefix} ${t.type}`}
              value={presets.some((preset) => preset.type === sensor.type) ? sensor.type : "custom"}
              onChange={(event) => {
                const preset = presets.find((item) => item.type === Number(event.target.value));
                if (preset) update({ type: preset.type, name: preset.name, mode: 0 });
                else update({ type: 1, name: "CUSTOM", mode: 0 });
              }}
            >
              {presets.map((preset) => (
                <option key={preset.type} value={preset.type}>
                  {preset.label} ({preset.type})
                </option>
              ))}
              <option value="custom">{t.custom}</option>
            </select>
          </label>
          <NumberInput
            label={`${prefix} ${t.mode}`}
            value={sensor.mode}
            min={0}
            max={7}
            integer
            t={t}
            onChange={(mode) => update({ mode })}
          />
          <NumberInput
            label={`${prefix} ${t.sensorType}`}
            value={sensor.type}
            min={0}
            max={127}
            integer
            t={t}
            onChange={(type) =>
              update({
                type,
                name: presets.find((preset) => preset.type === type)?.name ?? "CUSTOM",
              })
            }
          />
          <NumberInput
            label={`${prefix} ${t.percent}`}
            value={sensor.percent}
            min={-100}
            max={100}
            integer
            t={t}
            onChange={(percent) => update({ percent })}
          />
          <ValuesInput
            label={`${prefix} ${t.si}`}
            values={sensor.si}
            t={t}
            onChange={(si) => update({ si })}
          />
          <ValuesInput
            label={`${prefix} ${t.raw}`}
            values={sensor.raw}
            t={t}
            onChange={(raw) => update({ raw })}
          />
        </div>
        <label className="preview-sensor-busy">
          <input
            type="checkbox"
            checked={sensor.busy}
            onChange={(event) => update({ busy: event.target.checked })}
          />
          {t.busy}
        </label>
      </fieldset>
    </details>
  );
}
