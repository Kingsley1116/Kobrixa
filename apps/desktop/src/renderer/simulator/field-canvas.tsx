import { useEffect, useRef, useState } from "react";
import type { SimulationScene, SimulationSnapshot } from "../../shared/simulator.js";
import { FIELD } from "../../simulation/scene.js";
import { Icon } from "../components/icon.js";
import {
  drawField,
  FIT_CAMERA,
  fieldPoint,
  fieldTransform,
  HANDLE_RADIUS,
  headingToward,
  liveBalls,
  livePose,
  normalizeHeading,
  pointInRobot,
  readPalette,
  rotationHandle,
  screenPoint,
  zoomAt,
  type FieldCamera,
  type FieldLayers,
  type FieldModel,
  type FieldPalette,
} from "./field-renderer.js";
import type { SimulatorCopy } from "./simulator-copy.js";

export { fieldPoint, fieldTransform, type FieldCamera } from "./field-renderer.js";

type Hover = FieldModel["hover"];
interface Drag {
  kind: "robot" | "ball" | "rotate" | "pan";
  id: string;
  /** Pointer position at drag start, in screen pixels. */
  x: number;
  y: number;
  /** Field offset between the pointer and the dragged object's centre. */
  offsetX: number;
  offsetY: number;
  panX: number;
  panY: number;
}
const clampField = (point: { x: number; y: number }) => ({
  x: Math.round(Math.max(0, Math.min(FIELD.width, point.x))),
  y: Math.round(Math.max(0, Math.min(FIELD.height, point.y))),
});

export function FieldCanvas({
  scene,
  snapshot,
  selectedRobot,
  selectedBall,
  onSelectRobot,
  onSelectBall,
  onSceneChange,
  editable,
  layers,
  t,
}: {
  scene: SimulationScene;
  snapshot: SimulationSnapshot | null;
  selectedRobot: string;
  selectedBall: string | null;
  onSelectRobot(id: string): void;
  onSelectBall(id: string | null): void;
  onSceneChange(scene: SimulationScene): void;
  editable: boolean;
  layers: FieldLayers;
  t: SimulatorCopy;
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 700, height: 400, dpr: 1 });
  const [camera, setCamera] = useState<FieldCamera>(FIT_CAMERA);
  const [hover, setHover] = useState<Hover>(null);
  const [palette, setPalette] = useState<FieldPalette | null>(null);
  const [dragging, setDragging] = useState<Drag["kind"] | null>(null);
  const drag = useRef<Drag | null>(null);
  // Pointer moves arrive faster than frames; commit at most one scene edit per frame.
  const pending = useRef<((scene: SimulationScene) => SimulationScene) | null>(null);
  const frame = useRef(0);
  const latest = useRef({ scene, onSceneChange });
  latest.current = { scene, onSceneChange };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () =>
      setSize({
        width: element.clientWidth || 700,
        height: element.clientHeight || 400,
        dpr: window.devicePixelRatio || 1,
      });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Theme tokens live in CSS; re-read them whenever the app theme or OS scheme flips.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => setPalette(readPalette(element));
    update();
    const observer =
      typeof MutationObserver === "undefined" ? undefined : new MutationObserver(update);
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", update);
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.("change", update);
    };
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !palette) return;
    const width = Math.round(size.width * size.dpr),
      height = Math.round(size.height * size.dpr);
    if (element.width !== width) element.width = width;
    if (element.height !== height) element.height = height;
    const ctx = element.getContext("2d");
    if (!ctx) return;
    drawField(ctx, { ...size, camera }, palette, {
      scene,
      snapshot,
      selectedRobot,
      selectedBall,
      hover,
      editable,
      layers,
    });
  }, [
    scene,
    snapshot,
    selectedRobot,
    selectedBall,
    hover,
    editable,
    layers,
    size,
    camera,
    palette,
  ]);

  const schedule = (edit: (scene: SimulationScene) => SimulationScene) => {
    pending.current = edit;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next) latest.current.onSceneChange(next(latest.current.scene));
    });
  };
  const flush = () => {
    if (!frame.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const next = pending.current;
    pending.current = null;
    if (next) latest.current.onSceneChange(next(latest.current.scene));
  };
  const editRobot =
    (id: string, patch: (pose: SimulationScene["robots"][number]["pose"]) => object) =>
    (current: SimulationScene) => ({
      ...current,
      robots: current.robots.map((robot) =>
        robot.id === id ? { ...robot, pose: { ...robot.pose, ...patch(robot.pose) } } : robot,
      ),
    });
  const editBall =
    (id: string, patch: (ball: SimulationScene["balls"][number]) => object) =>
    (current: SimulationScene) => ({
      ...current,
      balls: current.balls.map((ball) => (ball.id === id ? { ...ball, ...patch(ball) } : ball)),
    });

  const local = (event: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const hitTest = (screen: { x: number; y: number }): Hover => {
    const scale = fieldTransform(size.width, size.height, camera).scale;
    const point = fieldPoint(screen.x, screen.y, size.width, size.height, camera);
    const selected = scene.robots.find((robot) => robot.id === selectedRobot);
    if (editable && selected) {
      const handle = rotationHandle(selected, selected.pose, scale),
        at = screenPoint(handle.x, handle.y, size.width, size.height, camera);
      if (Math.hypot(at.x - screen.x, at.y - screen.y) <= HANDLE_RADIUS + 4)
        return { kind: "handle", id: selected.id };
    }
    const slop = 6 / scale;
    const ball = [...liveBalls({ scene, snapshot })]
      .reverse()
      .find((ball) => Math.hypot(ball.x - point.x, ball.y - point.y) <= FIELD.ballRadius + slop);
    if (ball) return { kind: "ball", id: ball.id };
    const robot = [...scene.robots]
      .reverse()
      .find((robot) => pointInRobot(robot, livePose({ snapshot }, robot), point, slop));
    return robot ? { kind: "robot", id: robot.id } : null;
  };
  const sameHover = (a: Hover, b: Hover) => a?.kind === b?.kind && a?.id === b?.id;
  const zoomBy = (factor: number, screen = { x: size.width / 2, y: size.height / 2 }) =>
    setCamera((old) => zoomAt(old, size.width, size.height, screen.x, screen.y, factor));

  const cursor =
    dragging === "pan"
      ? "grabbing"
      : dragging
        ? "move"
        : hover?.kind === "handle"
          ? "crosshair"
          : hover && editable
            ? "move"
            : hover
              ? "pointer"
              : "grab";

  return (
    <div className="sim-field">
      <div ref={host} className="sim-field-viewport">
        <canvas
          ref={canvas}
          data-testid="simulator-field"
          role="img"
          aria-label={t.field}
          tabIndex={0}
          style={{ cursor }}
          onWheel={(event) => {
            event.preventDefault();
            zoomBy(Math.exp(-event.deltaY * 0.0015), local(event));
          }}
          onDoubleClick={(event) => {
            if (!hitTest(local(event))) setCamera(FIT_CAMERA);
          }}
          onKeyDown={(event) => {
            if (event.key === "+" || event.key === "=") zoomBy(1.25);
            else if (event.key === "-") zoomBy(0.8);
            else if (event.key === "0") setCamera(FIT_CAMERA);
            else if (editable && event.key.startsWith("Arrow")) {
              const step = event.shiftKey ? 50 : 10;
              const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
                dy = event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0;
              if (selectedBall)
                onSceneChange(
                  editBall(selectedBall, (ball) => clampField({ x: ball.x + dx, y: ball.y + dy }))(
                    scene,
                  ),
                );
              else if (selectedRobot)
                onSceneChange(
                  editRobot(selectedRobot, (pose) =>
                    clampField({ x: pose.x + dx, y: pose.y + dy }),
                  )(scene),
                );
            } else if (editable && selectedRobot && /^[qe]$/i.test(event.key)) {
              const delta = (event.shiftKey ? 15 : 5) * (event.key.toLowerCase() === "q" ? 1 : -1);
              onSceneChange(
                editRobot(selectedRobot, (pose) => ({
                  heading: normalizeHeading(pose.heading + delta),
                }))(scene),
              );
            } else return;
            event.preventDefault();
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            const screen = local(event),
              point = fieldPoint(screen.x, screen.y, size.width, size.height, camera),
              hit = hitTest(screen);
            if (hit?.kind === "ball") onSelectBall(hit.id);
            else if (hit?.kind === "robot") onSelectRobot(hit.id);
            else if (!hit) onSelectBall(null);
            const ball =
                hit?.kind === "ball" ? scene.balls.find((item) => item.id === hit.id) : undefined,
              robot =
                hit?.kind === "robot" ? scene.robots.find((item) => item.id === hit.id) : undefined;
            const origin = ball ?? robot?.pose;
            const kind: Drag["kind"] =
              hit?.kind === "handle"
                ? "rotate"
                : editable && origin
                  ? ball
                    ? "ball"
                    : "robot"
                  : "pan";
            drag.current = {
              kind,
              id: hit?.id ?? "",
              ...screen,
              offsetX: origin ? origin.x - point.x : 0,
              offsetY: origin ? origin.y - point.y : 0,
              panX: camera.panX,
              panY: camera.panY,
            };
            setDragging(kind);
          }}
          onPointerMove={(event) => {
            const screen = local(event),
              current = drag.current;
            if (!current) {
              const next = hitTest(screen);
              if (!sameHover(next, hover)) setHover(next);
              return;
            }
            if (current.kind === "pan") {
              setCamera((old) => ({
                ...old,
                panX: current.panX + screen.x - current.x,
                panY: current.panY + screen.y - current.y,
              }));
              return;
            }
            if (!editable) return;
            const point = fieldPoint(screen.x, screen.y, size.width, size.height, camera);
            if (current.kind === "rotate") {
              const shift = event.shiftKey;
              schedule(
                editRobot(current.id, (pose) => ({ heading: headingToward(pose, point, shift) })),
              );
              return;
            }
            const position = clampField({
              x: point.x + current.offsetX,
              y: point.y + current.offsetY,
            });
            schedule(
              current.kind === "robot"
                ? editRobot(current.id, () => position)
                : editBall(current.id, () => position),
            );
          }}
          onPointerLeave={() => {
            if (!drag.current) setHover(null);
          }}
          onPointerUp={() => {
            flush();
            drag.current = null;
            setDragging(null);
          }}
          onPointerCancel={() => {
            flush();
            drag.current = null;
            setDragging(null);
          }}
          onLostPointerCapture={() => {
            flush();
            drag.current = null;
            setDragging(null);
          }}
        />
      </div>
      <div className="sim-float sim-zoom" role="group" aria-label={t.field}>
        <button aria-label={t.zoomOut} title={t.zoomOut} onClick={() => zoomBy(0.8)}>
          <Icon name="zoom-out" />
        </button>
        <span aria-live="polite">{Math.round(camera.zoom * 100)}%</span>
        <button aria-label={t.zoomIn} title={t.zoomIn} onClick={() => zoomBy(1.25)}>
          <Icon name="zoom-in" />
        </button>
        <button aria-label={t.fit} title={t.fit} onClick={() => setCamera(FIT_CAMERA)}>
          <Icon name="fit" />
        </button>
      </div>
    </div>
  );
}
