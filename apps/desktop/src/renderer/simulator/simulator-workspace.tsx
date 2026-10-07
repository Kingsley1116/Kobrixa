import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SourceSpan } from "@kobrixa/ir";
import type { PreparedSimulation, SimulationScene } from "../../shared/simulator.js";
import type { PreviewButton } from "../../preview/virtual-device.js";
import { createDefaultScene, validateScene } from "../../simulation/scene.js";
import { Icon } from "../components/icon.js";
import { TabList } from "../components/tab-list.js";
import { EventsPanel } from "./events-panel.js";
import { FieldCanvas } from "./field-canvas.js";
import { TEAM_COLORS, type FieldLayers } from "./field-renderer.js";
import { InspectorPanel } from "./inspector-panel.js";
import { LayersMenu } from "./layers-menu.js";
import { RobotSettings } from "./robot-settings.js";
import { ScenePanel } from "./scene-panel.js";
import { Scoreboard } from "./scoreboard.js";
import { SimulatorController } from "./simulator-controller.js";
import { simulatorCopy, type SimulatorLocale } from "./simulator-copy.js";
import { TransportBar } from "./transport-bar.js";
import "./simulator.css";

export interface SimulatorWorkspaceProps {
  scene: SimulationScene;
  entries: string[];
  locale: SimulatorLocale;
  projectName: string;
  active?: boolean;
  blocked?: boolean;
  onSceneChange(scene: SimulationScene): void;
  onSave(scene: SimulationScene): void | Promise<void>;
  onPrepare(scene: SimulationScene): Promise<PreparedSimulation>;
  onCancelPrepare?(): void;
  onClose(): void;
  onSource?(span: SourceSpan): void;
}
type Tab = "scene" | "setup" | "inspect" | "events";
const DEFAULT_LAYERS: FieldLayers = {
  traces: true,
  rays: false,
  headings: true,
  collisions: true,
  restrictedZones: true,
};

export function SimulatorWorkspace({
  scene,
  entries,
  locale,
  projectName,
  active = true,
  blocked = false,
  onSceneChange,
  onSave,
  onPrepare,
  onCancelPrepare,
  onClose,
  onSource,
}: SimulatorWorkspaceProps): React.JSX.Element {
  const t = simulatorCopy[locale];
  const prepare = useRef(onPrepare);
  prepare.current = onPrepare;
  const cancelPrepare = useRef(onCancelPrepare);
  cancelPrepare.current = onCancelPrepare;
  const [controller] = useState(
    () =>
      new SimulatorController(
        scene,
        (next) => prepare.current(validateScene(next)),
        undefined,
        () => cancelPrepare.current?.(),
      ),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [selected, setSelected] = useState(scene.robots[0]?.id ?? "");
  const [selectedBall, setSelectedBall] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("setup");
  const [speed, setSpeed] = useState(1);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [saveMessage, setSaveMessage] = useState<string | null>(null),
    [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const held = useRef(new Set<PreviewButton>());
  const [heldButtons, setHeldButtons] = useState<PreviewButton[]>([]);
  const workspace = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!workspace.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.height > 0) setCompact(entry.contentRect.height < 480);
    });
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  const [expanded, setExpanded] = useState(false);
  const showSource = onSource
    ? (span: SourceSpan) => {
        setExpanded(false);
        onSource(span);
      }
    : undefined;
  const snapshot = state.snapshot,
    debug = snapshot?.debug;
  const robot = scene.robots.find((robot) => robot.id === selected) ?? scene.robots[0];
  const running = snapshot?.status === "running",
    terminal = ["stopped", "completed", "error"].includes(snapshot?.status ?? "");
  const editable = !blocked && !state.preparing && (!snapshot || snapshot.status === "ready");
  const release = () => {
    held.current.clear();
    setHeldButtons([]);
    controller.send({ type: "buttons", robotId: selected, buttons: [] });
  };
  const selectRobot = (id: string) => {
    if (id !== selected) release();
    setSelected(id);
    setSelectedBall(null);
  };
  useEffect(() => {
    controller.setScene(scene);
    if (!scene.robots.some((robot) => robot.id === selected))
      setSelected(scene.robots[0]?.id ?? "");
  }, [scene, controller, selected]);
  useEffect(() => {
    controller.select(selected);
    return () => controller.send({ type: "buttons", robotId: selected, buttons: [] });
  }, [selected, controller]);
  useEffect(() => {
    controller.setActive(active && !blocked && !document.hidden);
    if (!active || blocked) release();
    const hidden = () => {
      controller.setActive(active && !blocked && !document.hidden);
      if (document.hidden) release();
    };
    const blur = () => release();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", blur);
    };
  }, [active, blocked, controller, selected]);
  useEffect(() => {
    mounted.current = true;
    controller.attach();
    return () => {
      mounted.current = false;
      controller.dispose();
    };
  }, [controller]);
  const press = (button: PreviewButton, down: boolean) => {
    if (down) held.current.add(button);
    else held.current.delete(button);
    const buttons = [...held.current];
    setHeldButtons(buttons);
    controller.send({ type: "buttons", robotId: selected, buttons });
  };
  const change = (next: SimulationScene) => {
    if (editable) {
      setSaveMessage(null);
      onSceneChange(next);
    }
  };
  const save = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await onSave(validateScene(scene));
      if (mounted.current) setSaveMessage(t.saved);
    } catch (error) {
      if (mounted.current)
        setSaveMessage(
          `${t.saveFailed}: ${error instanceof Error ? error.message : String(error)}`,
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const runtimeError =
    snapshot?.status === "error"
      ? snapshot.events.filter((event) => event.kind === "error").at(-1)
      : undefined;
  const errorRobot = scene.robots.find((robot) => robot.id === runtimeError?.robotId);
  const errorSpan = runtimeError?.span;
  const tabs = [
    ["scene", t.scene],
    ["setup", t.config],
    ["inspect", t.inspector],
    ["events", t.events],
  ] as const;
  const eventCount = snapshot?.events.length ?? 0;
  // Keep the execution state separate from the program or built-in controller assignment.
  const robotStatus = (status: string | undefined, kind: string) => {
    const key =
      (status === "builtin" ? snapshot?.status : status) ??
      (kind === "disabled" ? "disabled" : "ready");
    return key in t ? String(t[key as keyof typeof t]) : key;
  };
  return (
    <section
      ref={workspace}
      data-compact={compact}
      data-expanded={expanded}
      className="simulator-workspace"
      aria-label={t.title}
      hidden={!active}
    >
      <TransportBar
        t={t}
        projectName={projectName}
        expanded={expanded}
        onExpand={() => setExpanded((value) => !value)}
        running={running}
        speed={speed}
        canStart={!blocked && !state.preparing && active}
        canStep={!blocked && !running && !state.preparing && !terminal && !!snapshot}
        canStop={!!snapshot || state.preparing}
        canReset={!blocked}
        canRebuild={!blocked && !state.preparing}
        canSave={!blocked && !saving}
        onStart={() => {
          if (running) controller.pause();
          else {
            controller.start();
            setTab("inspect");
          }
        }}
        onStep={() => controller.send({ type: "step" })}
        onStop={() => {
          release();
          controller.stop();
        }}
        onReset={() => {
          release();
          controller.reset();
          setTab("setup");
        }}
        onRebuild={() => {
          release();
          void controller.recompile();
        }}
        onSave={() => void save()}
        onSpeed={(value) => {
          setSpeed(value);
          controller.setSpeed(value);
        }}
        onClose={onClose}
      />
      <Scoreboard
        t={t}
        snapshot={snapshot}
        preparing={state.preparing}
        failed={!!state.error}
        durationMs={scene.durationMs}
        saveMessage={saveMessage}
      />
      {(state.error || runtimeError) && (
        <div className="sim-error" role="alert">
          <div>
            <p>
              {state.error ?? (
                <>
                  {runtimeError?.robotId && (
                    <strong>
                      {runtimeError.robotId}
                      {errorRobot && errorRobot.name !== errorRobot.id
                        ? ` · ${errorRobot.name}`
                        : ""}
                      :{" "}
                    </strong>
                  )}
                  {runtimeError?.message}
                </>
              )}
            </p>
            <small>{t.errorHint}</small>
          </div>
          {!state.error && errorSpan && onSource && (
            <button
              type="button"
              onClick={() => {
                if (errorRobot) selectRobot(errorRobot.id);
                setTab("inspect");
                showSource?.(errorSpan);
              }}
            >
              {t.source} · {errorSpan.file}:{errorSpan.start.line}:{errorSpan.start.column}
            </button>
          )}
        </div>
      )}
      <div className="sim-body">
        <main className="sim-stage">
          <div className="sim-stage-field">
            <FieldCanvas
              scene={scene}
              snapshot={snapshot}
              selectedRobot={selected}
              selectedBall={selectedBall}
              onSelectRobot={selectRobot}
              onSelectBall={(id) => {
                setSelectedBall(id);
                if (id && editable) setTab("scene");
              }}
              onSceneChange={change}
              editable={editable}
              layers={layers}
              t={t}
            />
            <LayersMenu t={t} locale={locale} layers={layers} onChange={setLayers} />
            {editable && <p className="sim-field-hint">{t.fieldHint}</p>}
          </div>
          <div className="sim-robots" role="group" aria-label={t.robots}>
            {scene.robots.map((robot) => {
              const live = snapshot?.robots.find((item) => item.id === robot.id);
              const source =
                robot.controller.kind === "program"
                  ? robot.controller.entry
                  : robot.controller.kind === "builtin"
                    ? t.builtinLevels[robot.controller.level ?? "standard"]
                    : t.disabled;
              const sourceLabel =
                robot.controller.kind === "program" ? `${t.program} · ${source}` : source;
              return (
                <button
                  key={robot.id}
                  type="button"
                  data-testid={`simulator-robot-${robot.id}`}
                  aria-pressed={selected === robot.id}
                  data-disabled={robot.controller.kind === "disabled"}
                  style={{ "--team": TEAM_COLORS[robot.team] } as React.CSSProperties}
                  onClick={() => selectRobot(robot.id)}
                >
                  <span className="sim-robot-name">
                    <i aria-hidden="true" />
                    {robot.name || robot.id}
                    <small aria-label={t.status}>
                      {robotStatus(live?.status, robot.controller.kind)}
                    </small>
                  </span>
                  <span
                    className="sim-robot-source"
                    title={sourceLabel}
                    aria-label={`${t.controllerSource}: ${sourceLabel}`}
                  >
                    {robot.controller.kind === "program" ? source.split(/[\\/]/).at(-1) : source}
                  </span>
                  <span className="sim-robot-stats">
                    <span data-testid="simulator-robot-distance">
                      {(live?.distance ?? 0).toFixed(0)} mm
                    </span>
                    <span>{(live?.pose.heading ?? robot.pose.heading).toFixed(0)}°</span>
                  </span>
                </button>
              );
            })}
          </div>
        </main>
        <aside className="sim-sidebar">
          <TabList<Tab>
            className="sim-tabs"
            variant="compact"
            label={t.title}
            tabs={tabs.map(([value, label]) => ({
              value,
              label: value === "events" && eventCount > 0 ? `${label} (${eventCount})` : label,
              id: `sim-tab-${value}`,
              panelId: `sim-panel-${value}`,
            }))}
            value={tab}
            onChange={setTab}
          />
          <div
            id={`sim-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`sim-tab-${tab}`}
            className="sim-side-content"
          >
            {tab === "scene" && (
              <ScenePanel
                t={t}
                scene={scene}
                selectedBall={selectedBall}
                editable={editable}
                onChange={change}
              />
            )}
            {tab === "setup" && robot && (
              <>
                <div className="sim-robot-header">
                  <span style={{ "--team": TEAM_COLORS[robot.team] } as React.CSSProperties}>
                    <i aria-hidden="true" />
                    {robot.id}
                  </span>
                  <button
                    type="button"
                    disabled={!editable || scene.robots.length >= 4}
                    onClick={() => {
                      const template = createDefaultScene(entries[0]).robots.find(
                        (item) => !scene.robots.some((robot) => robot.id === item.id),
                      );
                      if (template) {
                        change({ ...scene, robots: [...scene.robots, template] });
                        setSelected(template.id);
                      }
                    }}
                  >
                    <Icon name="plus" />
                    {t.addRobot}
                  </button>
                  <button
                    type="button"
                    className="sim-danger"
                    disabled={!editable || scene.robots.length <= 1}
                    onClick={() =>
                      change({
                        ...scene,
                        robots: scene.robots.filter((item) => item.id !== selected),
                      })
                    }
                  >
                    {t.removeRobot}
                  </button>
                </div>
                <RobotSettings
                  locale={locale}
                  scene={scene}
                  robot={robot}
                  entries={entries}
                  onChange={change}
                  disabled={!editable}
                  t={t}
                />
              </>
            )}
            {tab === "inspect" && (
              <InspectorPanel
                t={t}
                debug={debug}
                live={snapshot?.robots.find((item) => item.id === selected)}
                held={heldButtons}
                blocked={blocked}
                onPress={press}
                onRelease={release}
                {...(showSource ? { onSource: showSource } : {})}
              />
            )}
            {tab === "events" && (
              <EventsPanel
                t={t}
                events={snapshot?.events ?? []}
                scene={scene}
                {...(showSource ? { onSource: showSource } : {})}
              />
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
