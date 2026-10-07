import { useEffect, useState } from "react";
import {
  DEFAULT_PIXY2_CONFIG,
  OPPONENT_LEVELS,
  type OpponentLevel,
  type RobotConfig,
  type SimulationDrive,
  type SimulationScene,
  type SimulationSensor,
  type SimulationWheel,
} from "../../shared/simulator.js";
import { createDriveWheels, FIELD } from "../../simulation/scene.js";
import { Icon } from "../components/icon.js";
import { Segmented } from "../components/segmented.js";
import { Picker } from "../components/picker.js";
import type { SimulatorCopy, SimulatorLocale } from "./simulator-copy.js";

export function SimNumber({
  label,
  value,
  onChange,
  min = -10000,
  max = 10000,
  step = "any",
  disabled = false,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number | "any";
  disabled?: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft),
    valid =
      draft.trim() !== "" &&
      Number.isFinite(parsed) &&
      parsed >= min &&
      parsed <= max &&
      (step !== 1 || Number.isInteger(parsed));
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-invalid={!valid}
        title={valid ? undefined : `${min} – ${max}`}
        onChange={(event) => {
          const next = event.target.value,
            value = Number(next);
          setDraft(next);
          if (
            next.trim() &&
            Number.isFinite(value) &&
            value >= min &&
            value <= max &&
            (step !== 1 || Number.isInteger(value))
          )
            onChange(value);
        }}
      />
    </label>
  );
}
function Port({
  value,
  onChange,
  disabled,
  locale,
  t,
}: {
  value: SimulationWheel["port"];
  onChange(value: SimulationWheel["port"]): void;
  disabled: boolean;
  locale: SimulatorLocale;
  t: SimulatorCopy;
}): React.JSX.Element {
  return (
    <div className="sim-field-group">
      <span>{t.port}</span>
      <Picker
        locale={locale}
        label={t.port}
        disabled={disabled}
        value={value}
        onChange={onChange}
        options={(["A", "B", "C", "D"] as const).map((value) => ({ value, label: value }))}
      />
    </div>
  );
}

export function RobotSettings({
  locale,
  scene,
  robot,
  entries,
  onChange,
  disabled,
  t,
}: {
  locale: SimulatorLocale;
  scene: SimulationScene;
  robot: RobotConfig;
  entries: string[];
  onChange(scene: SimulationScene): void;
  disabled: boolean;
  t: SimulatorCopy;
}): React.JSX.Element {
  const update = (patch: Partial<RobotConfig>) =>
    onChange({
      ...scene,
      robots: scene.robots.map((item) => (item.id === robot.id ? { ...item, ...patch } : item)),
    });
  const wheel = (index: number, patch: Partial<SimulationWheel>) =>
    update({ wheels: robot.wheels.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  const sensor = (index: number, patch: Partial<SimulationSensor>) =>
    update({
      sensors: robot.sensors.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  const controller =
    robot.controller.kind === "program"
      ? `program:${robot.controller.entry}`
      : robot.controller.kind === "builtin"
        ? `builtin:${robot.controller.level ?? "standard"}`
        : robot.controller.kind;
  const availableEntries = [
    ...new Set([
      ...entries,
      ...(robot.controller.kind === "program" ? [robot.controller.entry] : []),
    ]),
  ];
  return (
    <fieldset className="sim-robot-settings" disabled={disabled}>
      <legend className="sim-sr-only">{robot.name}</legend>
      {disabled && <p className="sim-hint">{t.setupRequired}</p>}
      <section className="sim-section">
        <h3>{t.basics}</h3>
        <div className="sim-fields">
          <label>
            {t.robotName}
            <input
              value={robot.name}
              maxLength={32}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <div className="sim-field-group">
            <span id={`sim-team-${robot.id}`}>{t.team}</span>
            <Segmented
              labelledBy={`sim-team-${robot.id}`}
              disabled={disabled}
              options={[
                { value: "A", label: "A" },
                { value: "B", label: "B" },
              ]}
              value={robot.team}
              onChange={(team) => update({ team })}
            />
          </div>
          <div className="sim-field-group sim-wide">
            <span>{t.controller}</span>
            <Picker
              locale={locale}
              label={t.controller}
              disabled={disabled}
              searchable
              value={controller}
              options={[
                ...availableEntries.map((entry) => ({
                  value: `program:${entry}`,
                  label: `${t.program}: ${entry}`,
                })),
                ...OPPONENT_LEVELS.map((level) => ({
                  value: `builtin:${level}`,
                  label: t.builtinLevels[level],
                })),
                { value: "disabled", label: t.disabled },
              ]}
              onChange={(value) =>
                update({
                  controller: value.startsWith("program:")
                    ? { kind: "program", entry: value.slice(8) }
                    : value.startsWith("builtin:")
                      ? { kind: "builtin", level: value.slice(8) as OpponentLevel }
                      : { kind: "disabled" },
                })
              }
            />
          </div>
        </div>
      </section>
      <section className="sim-section">
        <h3>{t.pose}</h3>
        <div className="sim-fields sim-fields-3">
          <SimNumber
            label={t.x}
            value={robot.pose.x}
            min={0}
            max={FIELD.width}
            onChange={(x) => update({ pose: { ...robot.pose, x } })}
          />
          <SimNumber
            label={t.y}
            value={robot.pose.y}
            min={0}
            max={FIELD.height}
            onChange={(y) => update({ pose: { ...robot.pose, y } })}
          />
          <SimNumber
            label={t.heading}
            value={robot.pose.heading}
            min={-360}
            max={360}
            onChange={(heading) => update({ pose: { ...robot.pose, heading } })}
          />
        </div>
      </section>
      <section className="sim-section">
        <h3>{t.body}</h3>
        <div className="sim-fields sim-fields-3">
          <SimNumber
            label={t.width}
            value={robot.width}
            min={40}
            max={200}
            onChange={(width) => update({ width })}
          />
          <SimNumber
            label={t.length}
            value={robot.length}
            min={40}
            max={200}
            onChange={(length) => update({ length })}
          />
          <SimNumber
            label={t.mass}
            value={robot.mass}
            min={0.1}
            max={1.2}
            onChange={(mass) => update({ mass })}
          />
        </div>
      </section>
      <details className="sim-section">
        <summary>
          {t.drive} · {t.wheels} <small>{robot.wheels.length}</small>
        </summary>
        <div className="sim-field-group">
          <span>{t.drive}</span>
          <Picker<SimulationDrive>
            locale={locale}
            label={t.drive}
            disabled={disabled}
            value={robot.drive}
            options={[
              { value: "differential", label: t.differential },
              { value: "omni3", label: t.omni3 },
              { value: "omni4", label: t.omni4 },
            ]}
            onChange={(drive) =>
              update({
                drive,
                wheels: createDriveWheels(drive),
                ...(drive === "omni4" ? { shooter: null } : {}),
              })
            }
          />
        </div>
        <div className="sim-field-group">
          <span>{t.wheelTraction}</span>
          <Picker<NonNullable<RobotConfig["wheelTraction"]>>
            locale={locale}
            label={t.wheelTraction}
            disabled={disabled}
            value={robot.wheelTraction ?? "slip"}
            options={[
              { value: "slip", label: t.wheelSlip },
              { value: "grip", label: t.wheelGrip },
            ]}
            onChange={(wheelTraction) => update({ wheelTraction })}
          />
        </div>
        {robot.wheels.map((item, index) => (
          <fieldset className="sim-config-card" key={index}>
            <legend>
              <span className="sim-port">{item.port}</span>
            </legend>
            <div className="sim-fields sim-fields-3">
              <Port
                value={item.port}
                onChange={(port) => wheel(index, { port })}
                t={t}
                locale={locale}
                disabled={disabled}
              />
              <SimNumber
                label={t.angle}
                value={item.angle}
                min={-360}
                max={360}
                onChange={(angle) => wheel(index, { angle })}
              />
              <SimNumber
                label={t.diameter}
                value={item.diameter}
                min={10}
                max={150}
                onChange={(diameter) => wheel(index, { diameter })}
              />
              <SimNumber label={t.x} value={item.x} onChange={(x) => wheel(index, { x })} />
              <SimNumber label={t.y} value={item.y} onChange={(y) => wheel(index, { y })} />
              <SimNumber
                label={t.gear}
                value={item.gearRatio}
                min={0.1}
                max={100}
                onChange={(gearRatio) => wheel(index, { gearRatio })}
              />
            </div>
            <label className="sim-checkbox">
              <input
                type="checkbox"
                checked={item.inverted}
                onChange={(event) => wheel(index, { inverted: event.target.checked })}
              />
              {t.inverted}
            </label>
          </fieldset>
        ))}
      </details>
      <details className="sim-section">
        <summary>
          {t.sensors} <small>{robot.sensors.length}</small>
        </summary>
        {robot.sensors.map((item, index) => (
          <fieldset className="sim-config-card" key={index}>
            <legend>
              <span className="sim-port">{item.port}</span> {t[item.kind]}
            </legend>
            <div className="sim-fields sim-fields-3">
              <div className="sim-field-group">
                <span>{t.port}</span>
                <Picker<SimulationSensor["port"]>
                  locale={locale}
                  label={t.port}
                  disabled={disabled}
                  value={item.port}
                  options={([1, 2, 3, 4] as const).map((value) => ({
                    value,
                    label: String(value),
                  }))}
                  onChange={(port) => sensor(index, { port })}
                />
              </div>
              <div className="sim-field-group sim-span-2">
                <span>{t.kind}</span>
                <Picker<SimulationSensor["kind"]>
                  locale={locale}
                  label={t.kind}
                  disabled={disabled}
                  value={item.kind}
                  options={(
                    ["color", "ultrasonic", "gyro", "touch", "vision", "pixy2"] as const
                  ).map((value) => ({ value, label: t[value] }))}
                  onChange={(kind) =>
                    sensor(index, {
                      kind,
                      range: kind === "gyro" ? 0 : kind === "color" || kind === "touch" ? 5 : 2500,
                      fov:
                        kind === "pixy2"
                          ? 60
                          : kind === "vision"
                            ? 120
                            : kind === "ultrasonic"
                              ? 30
                              : 0,
                      ...(kind === "pixy2"
                        ? { pixy2: item.pixy2 ?? { ...DEFAULT_PIXY2_CONFIG } }
                        : {}),
                    })
                  }
                />
              </div>
              <SimNumber label={t.x} value={item.x} onChange={(x) => sensor(index, { x })} />
              <SimNumber label={t.y} value={item.y} onChange={(y) => sensor(index, { y })} />
              <SimNumber
                label={t.angle}
                value={item.angle}
                min={-360}
                max={360}
                onChange={(angle) => sensor(index, { angle })}
              />
              <SimNumber
                label={t.range}
                value={item.range}
                min={0}
                max={5000}
                onChange={(range) => sensor(index, { range })}
              />
              <SimNumber
                label={t.fov}
                value={item.fov}
                min={item.kind === "pixy2" ? 1 : 0}
                max={item.kind === "pixy2" ? 170 : 360}
                onChange={(fov) => sensor(index, { fov })}
              />
            </div>
            {item.kind === "gyro" && (
              <label className="sim-checkbox">
                <input
                  type="checkbox"
                  checked={item.inverted ?? false}
                  onChange={(event) => sensor(index, { inverted: event.target.checked })}
                />
                {t.inverted}
              </label>
            )}
            {item.kind === "pixy2" && (
              <>
                <div className="sim-fields">
                  <SimNumber
                    label={t.cameraHeight}
                    value={(item.pixy2 ?? DEFAULT_PIXY2_CONFIG).height}
                    min={0}
                    max={500}
                    onChange={(height) =>
                      sensor(index, { pixy2: { ...(item.pixy2 ?? DEFAULT_PIXY2_CONFIG), height } })
                    }
                  />
                  <SimNumber
                    label={t.cameraPitch}
                    value={(item.pixy2 ?? DEFAULT_PIXY2_CONFIG).pitch}
                    min={-89}
                    max={89}
                    onChange={(pitch) =>
                      sensor(index, { pixy2: { ...(item.pixy2 ?? DEFAULT_PIXY2_CONFIG), pitch } })
                    }
                  />
                  <SimNumber
                    label={t.verticalFov}
                    value={(item.pixy2 ?? DEFAULT_PIXY2_CONFIG).verticalFov}
                    min={1}
                    max={170}
                    onChange={(verticalFov) =>
                      sensor(index, {
                        pixy2: { ...(item.pixy2 ?? DEFAULT_PIXY2_CONFIG), verticalFov },
                      })
                    }
                  />
                  {(["orangeSignature", "purpleSignature"] as const).map((key) => (
                    <div className="sim-field-group" key={key}>
                      <span>{t[key]}</span>
                      <Picker<number>
                        locale={locale}
                        label={t[key]}
                        disabled={disabled}
                        value={(item.pixy2 ?? DEFAULT_PIXY2_CONFIG)[key]}
                        options={Array.from({ length: 8 }, (_, value) => ({
                          value,
                          label: value === 0 ? t.untrained : String(value),
                        }))}
                        onChange={(value) =>
                          sensor(index, {
                            pixy2: { ...(item.pixy2 ?? DEFAULT_PIXY2_CONFIG), [key]: value },
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
                <p className="sim-hint">{t.pixy2SignatureHint}</p>
                <p className="sim-hint">{t.pixy2Hint}</p>
              </>
            )}
            <button
              type="button"
              className="sim-link sim-danger"
              onClick={() => update({ sensors: robot.sensors.filter((_, i) => i !== index) })}
            >
              {t.remove}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="sim-add"
          disabled={robot.sensors.length >= 4}
          onClick={() => {
            const port = ([1, 2, 3, 4] as const).find(
              (port) => !robot.sensors.some((sensor) => sensor.port === port),
            );
            if (port)
              update({
                sensors: [
                  ...robot.sensors,
                  {
                    port,
                    kind: "color",
                    x: robot.length / 2,
                    y: 0,
                    angle: 0,
                    range: 1000,
                    fov: 60,
                  },
                ],
              });
          }}
        >
          <Icon name="plus" />
          {t.addSensor}
        </button>
      </details>
      <details className="sim-section">
        <summary>{t.pusher}</summary>
        <label className="sim-switch">
          <input
            type="checkbox"
            role="switch"
            checked={!!robot.pusher}
            onChange={(event) =>
              update({ pusher: event.target.checked ? { width: robot.width, depth: 25 } : null })
            }
          />
          {t.pusher}
        </label>
        {robot.pusher && (
          <div className="sim-fields">
            <SimNumber
              label={t.width}
              value={robot.pusher.width}
              min={10}
              max={200}
              onChange={(width) => update({ pusher: { ...robot.pusher!, width } })}
            />
            <SimNumber
              label={t.depth}
              value={robot.pusher.depth}
              min={1}
              max={80}
              onChange={(depth) => update({ pusher: { ...robot.pusher!, depth } })}
            />
          </div>
        )}
      </details>
      <details className="sim-section">
        <summary>{t.shooter}</summary>
        <label className="sim-switch">
          <input
            type="checkbox"
            role="switch"
            checked={!!robot.shooter}
            disabled={robot.drive === "omni4"}
            onChange={(event) =>
              update({
                shooter: event.target.checked
                  ? {
                      port: "D",
                      x: robot.length / 2,
                      y: 0,
                      angle: 0,
                      elevation: 35,
                      stroke: 90,
                      speed: 2000,
                      range: 150,
                    }
                  : null,
              })
            }
          />
          {t.shooter}
        </label>
        {robot.drive === "omni4" && <p className="sim-hint">{t.noShooterPort}</p>}
        {robot.shooter && (
          <div className="sim-fields">
            <Port
              locale={locale}
              disabled={disabled}
              value={robot.shooter.port}
              onChange={(port) => update({ shooter: { ...robot.shooter!, port } })}
              t={t}
            />
            {(
              [
                ["x", t.x, -400, 400],
                ["y", t.y, -400, 400],
                ["angle", t.angle, -360, 360],
                ["elevation", t.elevation, 0, 80],
                ["stroke", t.stroke, 1, 3600],
                ["speed", t.shotSpeed, 100, 5000],
                ["range", t.range, 10, 200],
              ] as const
            ).map(([key, label, min, max]) => (
              <SimNumber
                key={key}
                label={label}
                value={robot.shooter![key]}
                min={min}
                max={max}
                onChange={(value) => update({ shooter: { ...robot.shooter!, [key]: value } })}
              />
            ))}
          </div>
        )}
      </details>
    </fieldset>
  );
}
