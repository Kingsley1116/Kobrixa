import { SIMULATION_SPEEDS, type SimulationRuleset } from "../../shared/simulator.js";
import { Icon } from "../components/icon.js";
import { Picker } from "../components/picker.js";
import { Segmented } from "../components/segmented.js";
import type { SimulatorCopy, SimulatorLocale } from "./simulator-copy.js";

function ToolButton({
  icon,
  label,
  testId,
  disabled,
  primary = false,
  pressed,
  onClick,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  testId: string;
  disabled?: boolean;
  primary?: boolean;
  pressed?: boolean;
  onClick(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={primary ? "primary" : undefined}
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="sim-label">{label}</span>
    </button>
  );
}

export function TransportBar({
  t,
  locale,
  projectName,
  field,
  onField,
  expanded,
  onExpand,
  running,
  speed,
  canStart,
  canStep,
  canReset,
  canSave,
  onStart,
  onStep,
  onReset,
  onSave,
  onSpeed,
  onClose,
}: {
  t: SimulatorCopy;
  locale: SimulatorLocale;
  projectName: string;
  field: SimulationRuleset;
  onField(field: SimulationRuleset): void;
  expanded: boolean;
  onExpand(): void;
  running: boolean;
  speed: number;
  canStart: boolean;
  canStep: boolean;
  canReset: boolean;
  canSave: boolean;
  onStart(): void;
  onStep(): void;
  onReset(): void;
  onSave(): void;
  onSpeed(value: number): void;
  onClose(): void;
}): React.JSX.Element {
  return (
    <header className="sim-transport">
      <div className="sim-title">
        <h2>{t.title}</h2>
        <div className="sim-title-meta">
          <span className="sim-project" title={projectName}>
            {projectName}
          </span>
          <div className="sim-field-select" data-testid="simulator-field-select">
            <Picker<SimulationRuleset>
              locale={locale}
              label={t.fieldLabel}
              options={[
                { value: "practice", label: t.fieldPractice },
                { value: "wro-double-tennis-2026", label: t.fieldWro },
              ]}
              value={field}
              onChange={onField}
            />
          </div>
        </div>
      </div>
      <div className="sim-transport-controls">
        <div className="sim-transport-group" role="group" aria-label={t.status}>
          <ToolButton
            primary
            icon={running ? "pause" : "play"}
            label={running ? t.pause : t.run}
            testId="simulator-start"
            disabled={!canStart}
            onClick={onStart}
          />
          <ToolButton
            icon="step"
            label={t.step}
            testId="simulator-step"
            disabled={!canStep}
            onClick={onStep}
          />
          <ToolButton
            icon="reset"
            label={t.reset}
            testId="simulator-reset"
            disabled={!canReset}
            onClick={onReset}
          />
        </div>
        <div className="sim-speed">
          <span id="sim-speed-label">{t.speed}</span>
          <Segmented
            labelledBy="sim-speed-label"
            options={SIMULATION_SPEEDS.map((value) => ({ value, label: `${value}×` }))}
            value={speed}
            onChange={onSpeed}
          />
        </div>
      </div>
      <div className="sim-transport-group sim-transport-end">
        <ToolButton
          icon="save"
          label={t.save}
          testId="simulator-save"
          disabled={!canSave}
          onClick={onSave}
        />
        <ToolButton
          icon={expanded ? "code" : "fit"}
          label={expanded ? t.showEditor : t.expand}
          testId="simulator-expand"
          pressed={expanded}
          onClick={onExpand}
        />
        <button
          type="button"
          className="sim-close"
          data-testid="simulator-close"
          aria-label={t.close}
          title={t.close}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
    </header>
  );
}
