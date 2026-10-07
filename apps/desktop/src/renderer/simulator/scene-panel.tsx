import type { SimulationScene } from "../../shared/simulator.js";
import { FIELD, randomizeBalls, rollMatchDuration } from "../../simulation/scene.js";
import { Segmented } from "../components/segmented.js";
import { SimNumber } from "./robot-settings.js";
import type { SimulatorCopy } from "./simulator-copy.js";

export function ScenePanel({
  t,
  scene,
  selectedBall,
  editable,
  onChange,
}: {
  t: SimulatorCopy;
  scene: SimulationScene;
  selectedBall: string | null;
  editable: boolean;
  onChange(scene: SimulationScene): void;
}): React.JSX.Element {
  const ball = scene.balls.find((item) => item.id === selectedBall);
  const editBall = (patch: Partial<(typeof scene.balls)[number]>) =>
    onChange({
      ...scene,
      balls: scene.balls.map((item) => (item.id === ball?.id ? { ...item, ...patch } : item)),
    });
  const orange = scene.balls.filter((item) => item.kind === "orange").length;
  return (
    <fieldset className="sim-scene-settings" disabled={!editable}>
      <legend className="sim-sr-only">{t.scene}</legend>
      {!editable && <p className="sim-hint">{t.setupRequired}</p>}
      <section className="sim-section">
        <h3 id="sim-mode-label">{t.mode}</h3>
        <Segmented
          labelledBy="sim-mode-label"
          disabled={!editable}
          options={[
            { value: "practice", label: t.practice },
            { value: "match", label: t.match },
          ]}
          value={scene.mode}
          onChange={(mode) =>
            onChange({
              ...scene,
              mode,
              // Matches need four active robots; promote disabled slots to the built-in opponent.
              robots:
                mode === "match"
                  ? scene.robots.map((robot) =>
                      robot.controller.kind === "disabled"
                        ? { ...robot, controller: { kind: "builtin" } }
                        : robot,
                    )
                  : scene.robots,
            })
          }
        />
      </section>
      <section className="sim-section">
        <h3>{t.balls}</h3>
        <div className="sim-fields">
          <SimNumber
            label={t.seed}
            value={scene.seed}
            min={0}
            max={4294967295}
            step={1}
            onChange={(seed) => onChange({ ...scene, seed })}
          />
          <SimNumber
            label={t.duration}
            value={scene.durationMs / 1000}
            min={10}
            max={600}
            step={1}
            onChange={(seconds) => onChange({ ...scene, durationMs: seconds * 1000 })}
          />
        </div>
        <div className="sim-row">
          <button
            type="button"
            onClick={() =>
              onChange({
                ...scene,
                balls: randomizeBalls(scene.seed),
                durationMs: rollMatchDuration(scene.seed),
              })
            }
          >
            {t.randomize}
          </button>
          <button
            type="button"
            onClick={() => {
              const seed = (scene.seed + 1) >>> 0;
              onChange({
                ...scene,
                seed,
                balls: randomizeBalls(seed),
                durationMs: rollMatchDuration(seed),
              });
            }}
          >
            {t.newSeed}
          </button>
        </div>
        <p className="sim-ball-summary">
          <i className="sim-ball" data-kind="orange" aria-hidden="true" /> {t.orange} {orange}
          <i className="sim-ball" data-kind="purple" aria-hidden="true" /> {t.purple}{" "}
          {scene.balls.length - orange}
        </p>
      </section>
      <section className="sim-section">
        <h3>
          {t.selectedBall}
          {ball && (
            <span className="sim-heading-meta">
              <i className="sim-ball" data-kind={ball.kind} aria-hidden="true" /> {ball.id}
            </span>
          )}
        </h3>
        {ball ? (
          <div className="sim-fields sim-fields-3">
            <SimNumber
              label={t.x}
              value={ball.x}
              min={0}
              max={FIELD.width}
              onChange={(x) => editBall({ x })}
            />
            <SimNumber
              label={t.y}
              value={ball.y}
              min={0}
              max={FIELD.height}
              onChange={(y) => editBall({ y })}
            />
            <SimNumber
              label={t.height}
              value={ball.z}
              min={20}
              max={2000}
              onChange={(z) => editBall({ z })}
            />
          </div>
        ) : (
          <p className="sim-empty">{t.noBall}</p>
        )}
      </section>
      <details className="sim-section sim-about">
        <summary>{t.about}</summary>
        <p className="sim-hint">{t.disclaimer}</p>
        <p className="sim-hint">{t.snapshotHint}</p>
      </details>
    </fieldset>
  );
}
