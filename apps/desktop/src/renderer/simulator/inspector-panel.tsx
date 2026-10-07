import { useEffect, useRef } from "react";
import type { SourceSpan } from "@kobrixa/ir";
import type { SimulationRobotSnapshot } from "../../shared/simulator.js";
import type { PreviewSnapshot } from "../../preview/runtime.js";
import type { PreviewButton } from "../../preview/virtual-device.js";
import { formatPreviewValue } from "../preview/offline-preview.js";
import { ButtonPad } from "./button-pad.js";
import type { SimulatorCopy } from "./simulator-copy.js";

const LCD_DARK = [25, 35, 24],
  LCD_LIGHT = [200, 214, 172];

export function InspectorPanel({
  t,
  debug,
  live,
  held,
  blocked,
  onPress,
  onRelease,
  onSource,
}: {
  t: SimulatorCopy;
  debug: PreviewSnapshot | undefined;
  live: SimulationRobotSnapshot | undefined;
  held: readonly PreviewButton[];
  blocked: boolean;
  onPress(button: PreviewButton, down: boolean): void;
  onRelease(): void;
  onSource?(span: SourceSpan): void;
}): React.JSX.Element {
  const lcd = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = lcd.current,
      image = debug?.device.lcd;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    if (!image) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const pixels = context.createImageData(image.width, image.height);
    for (let index = 0; index < image.pixels.length; index++) {
      const color = image.pixels[index] ? LCD_DARK : LCD_LIGHT;
      pixels.data[index * 4] = color[0]!;
      pixels.data[index * 4 + 1] = color[1]!;
      pixels.data[index * 4 + 2] = color[2]!;
      pixels.data[index * 4 + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [debug]);
  const span = debug?.error?.span ?? debug?.currentSpan;
  return (
    <>
      <div className="sim-brick">
        <canvas
          className="sim-lcd"
          ref={lcd}
          width={178}
          height={128}
          role="img"
          aria-label={t.lcd}
        />
        <ButtonPad t={t} held={held} disabled={blocked} onPress={onPress} onRelease={onRelease} />
      </div>
      <p className="sim-hint">{t.keyboardHint}</p>
      {live && (
        <dl className="sim-readout">
          <div>
            <dt>{t.status}</dt>
            <dd>{live.status}</dd>
          </div>
          <div>
            <dt>X</dt>
            <dd>{live.pose.x.toFixed(0)} mm</dd>
          </div>
          <div>
            <dt>Y</dt>
            <dd>{live.pose.y.toFixed(0)} mm</dd>
          </div>
          <div>
            <dt>{t.heading}</dt>
            <dd>{live.pose.heading.toFixed(1)}°</dd>
          </div>
          <div>
            <dt>{t.chassisHeight}</dt>
            <dd>{live.elevation.toFixed(1)} mm</dd>
          </div>
          <div>
            <dt>{t.distance}</dt>
            <dd>{live.distance.toFixed(0)} mm</dd>
          </div>
          {debug && (
            <div>
              <dt>{t.instructions}</dt>
              <dd>{debug.instructions}</dd>
            </div>
          )}
        </dl>
      )}
      {!debug ? (
        <p className="sim-empty">{t.noData}</p>
      ) : (
        <>
          {debug.error && (
            <p role="alert" className="sim-inline-error">
              {debug.error.message}
            </p>
          )}
          <section className="sim-section">
            <h3>{t.programLocation}</h3>
            <div className="sim-location">
              <code>{span ? `${span.file}:${span.start.line}:${span.start.column}` : "—"}</code>
              {span && onSource && (
                <button type="button" onClick={() => onSource(span)}>
                  {t.source}
                </button>
              )}
            </div>
            {debug.callStack.length > 0 && (
              <ol className="sim-code" aria-label={t.callStack}>
                {debug.callStack.map((frame, index) => (
                  <li key={`${index}-${frame}`}>{frame}</li>
                ))}
              </ol>
            )}
          </section>
          <section className="sim-section">
            <h3>{t.motors}</h3>
            <table className="sim-table">
              <tbody>
                {Object.values(debug.device.motors).map((motor) => (
                  <tr key={motor.port}>
                    <th>{motor.port}</th>
                    <td>
                      <span className="sim-meter" aria-hidden="true">
                        <span
                          style={{
                            width: `${Math.min(100, Math.abs(motor.speed)) / 2}%`,
                            [motor.speed < 0 ? "right" : "left"]: "50%",
                          }}
                        />
                      </span>
                      {motor.speed.toFixed(0)}%
                    </td>
                    <td>{motor.count.toFixed(1)}°</td>
                    <td aria-label={motor.busy ? "busy" : "idle"}>
                      <span className="sim-dot" data-on={motor.busy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="sim-section">
            <h3>{t.sensors}</h3>
            <table className="sim-table">
              <tbody>
                {Object.entries(debug.device.sensors).map(([port, sensor]) => (
                  <tr key={port}>
                    <th>{port}</th>
                    <td>
                      {sensor.name} <small>{sensor.mode}</small>
                    </td>
                    <td>
                      <code>{formatPreviewValue(sensor.si)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {((debug.truncatedVariables?.length ?? 0) > 0 ||
            (debug.omittedVariableCount ?? 0) > 0) && <p className="sim-hint">{t.shortened}</p>}
          {(
            [
              [t.variables, debug.globals],
              [t.locals, debug.locals],
            ] as const
          ).map(([title, values]) => (
            <details key={title} className="sim-section" open>
              <summary>
                {title} <small>{Object.keys(values).length}</small>
              </summary>
              <table className="sim-table">
                <tbody>
                  {Object.entries(values).map(([name, value]) => (
                    <tr key={name}>
                      <th>{name}</th>
                      <td>
                        <code>{formatPreviewValue(value)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </>
      )}
    </>
  );
}
