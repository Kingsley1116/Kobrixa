import type {
  RobotConfig,
  SimulationBall,
  SimulationPose,
  SimulationScene,
  SimulationSnapshot,
} from "../../shared/simulator.js";
import { FIELD } from "../../simulation/scene.js";

const DEG = Math.PI / 180;
/** Screen-space breathing room around the mat, in CSS pixels. */
const MARGIN = 24;
/** Extra room at the top so the floating zoom and layer controls never cover the mat. */
const TOP_INSET = 56;
/** Distance between the robot outline and its rotation handle, in CSS pixels. */
const HANDLE_GAP = 26;
export const HANDLE_RADIUS = 8;
export const TEAM_COLORS = { A: "#3a7be0", B: "#e0506b" } as const;

export interface FieldCamera {
  zoom: number;
  panX: number;
  panY: number;
}
export const FIT_CAMERA: FieldCamera = { zoom: 1, panX: 0, panY: 0 };
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 8;

/** Screen position of the mat's bottom-left corner before panning, for a given scale. */
function fitOrigin(width: number, height: number, scale: number) {
  return {
    x: (width - FIELD.width * scale) / 2,
    y: (TOP_INSET + height - MARGIN + FIELD.height * scale) / 2,
  };
}
export function fieldTransform(width: number, height: number, camera: FieldCamera) {
  const fit = Math.max(
    0.01,
    Math.min((width - MARGIN * 2) / FIELD.width, (height - TOP_INSET - MARGIN) / FIELD.height),
  );
  const scale = fit * camera.zoom,
    origin = fitOrigin(width, height, scale);
  return { scale, x: origin.x + camera.panX, y: origin.y + camera.panY };
}
export function fieldPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  camera: FieldCamera,
): { x: number; y: number } {
  const transform = fieldTransform(width, height, camera);
  return { x: (x - transform.x) / transform.scale, y: (transform.y - y) / transform.scale };
}
export function screenPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  camera: FieldCamera,
): { x: number; y: number } {
  const transform = fieldTransform(width, height, camera);
  return { x: transform.x + x * transform.scale, y: transform.y - y * transform.scale };
}

/** Zooms so the field point under the pointer stays under the pointer. */
export function zoomAt(
  camera: FieldCamera,
  width: number,
  height: number,
  screenX: number,
  screenY: number,
  factor: number,
): FieldCamera {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom * factor));
  const anchor = fieldPoint(screenX, screenY, width, height, camera);
  const scale = fieldTransform(width, height, { zoom, panX: 0, panY: 0 }).scale,
    origin = fitOrigin(width, height, scale);
  return {
    zoom,
    panX: screenX - anchor.x * scale - origin.x,
    panY: screenY + anchor.y * scale - origin.y,
  };
}

export const normalizeHeading = (degrees: number) => {
  const value = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return value === -180 ? 180 : value;
};

/** Robot extents in its own frame: +x is forward, including an optional front pusher. */
function robotExtents(robot: RobotConfig) {
  return {
    back: -robot.length / 2,
    front: robot.length / 2 + (robot.pusher?.depth ?? 0),
    half: Math.max(robot.width, robot.pusher?.width ?? 0) / 2,
  };
}
function toLocal(pose: SimulationPose, point: { x: number; y: number }) {
  const dx = point.x - pose.x,
    dy = point.y - pose.y,
    angle = -pose.heading * DEG;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}
export function pointInRobot(
  robot: RobotConfig,
  pose: SimulationPose,
  point: { x: number; y: number },
  margin = 0,
): boolean {
  const local = toLocal(pose, point),
    extents = robotExtents(robot);
  return (
    local.x >= extents.back - margin &&
    local.x <= extents.front + margin &&
    Math.abs(local.y) <= extents.half + margin
  );
}
/** The rotation handle sits ahead of the robot at a constant on-screen distance. */
export function rotationHandle(
  robot: RobotConfig,
  pose: SimulationPose,
  scale: number,
): { x: number; y: number } {
  const distance = robotExtents(robot).front + HANDLE_GAP / scale;
  return {
    x: pose.x + Math.cos(pose.heading * DEG) * distance,
    y: pose.y + Math.sin(pose.heading * DEG) * distance,
  };
}
export function headingToward(
  pose: { x: number; y: number },
  point: { x: number; y: number },
  snap: boolean,
): number {
  const raw = Math.atan2(point.y - pose.y, point.x - pose.x) / DEG;
  return normalizeHeading(snap ? Math.round(raw / 15) * 15 : Math.round(raw * 10) / 10);
}

export interface FieldPalette {
  background: string;
  frame: string;
  text: string;
  muted: string;
  accent: string;
  error: string;
  warning: string;
  label: string;
}
const FALLBACK_PALETTE: FieldPalette = {
  background: "#18212b",
  frame: "#364451",
  text: "#e6eaf0",
  muted: "#a4b0be",
  accent: "#88acff",
  error: "#f49999",
  warning: "#f2ca6a",
  label: "#1e2933",
};
export function readPalette(element: Element): FieldPalette {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--editor", FALLBACK_PALETTE.background),
    frame: token("--border", FALLBACK_PALETTE.frame),
    text: token("--text", FALLBACK_PALETTE.text),
    muted: token("--muted", FALLBACK_PALETTE.muted),
    accent: token("--accent", FALLBACK_PALETTE.accent),
    error: token("--error", FALLBACK_PALETTE.error),
    warning: token("--warning", FALLBACK_PALETTE.warning),
    label: token("--raised", FALLBACK_PALETTE.label),
  };
}

export interface FieldLayers {
  traces: boolean;
  rays: boolean;
  headings: boolean;
  collisions: boolean;
  restrictedZones: boolean;
}
export interface FieldModel {
  scene: SimulationScene;
  snapshot: SimulationSnapshot | null;
  selectedRobot: string;
  selectedBall: string | null;
  hover: { kind: "robot" | "ball" | "handle"; id: string } | null;
  editable: boolean;
  layers: FieldLayers;
}

export function livePose(model: Pick<FieldModel, "snapshot">, robot: RobotConfig) {
  return model.snapshot?.robots.find((item) => item.id === robot.id)?.pose ?? robot.pose;
}
export function liveBalls(model: Pick<FieldModel, "scene" | "snapshot">): SimulationBall[] {
  return model.snapshot?.balls ?? model.scene.balls;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawMat(ctx: CanvasRenderingContext2D, scale: number, palette: FieldPalette) {
  // Wall and drop shadow, sized in screen pixels so they stay crisp at every zoom.
  ctx.save();
  ctx.shadowColor = "#0006";
  ctx.shadowBlur = 18;
  // Shadow offsets ignore the canvas transform, so +y is down on screen.
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, FIELD.width, FIELD.height);
  ctx.restore();
  // Faint 100 mm grid once it is dense enough to help placement.
  if (scale * 100 >= 24) {
    ctx.strokeStyle = "#0000000f";
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    for (let x = 100; x < FIELD.width; x += 100) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, FIELD.height);
    }
    for (let y = 100; y < FIELD.height; y += 100) {
      ctx.moveTo(0, y);
      ctx.lineTo(FIELD.width, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "#111";
  for (const line of FIELD.verticalLines)
    ctx.fillRect(line.x - line.width / 2, 0, line.width, FIELD.height);
  for (const y of FIELD.leftLines) ctx.fillRect(0, y - 10, FIELD.midX, 20);
  for (const y of FIELD.rightLines) ctx.fillRect(FIELD.midX, y - 10, FIELD.midX, 20);
  // Ramp stripes cover underlying mat lines, matching the mounted color sensor sampler.
  for (const ramp of FIELD.ramps) {
    for (const stripe of [
      { offset: 0, width: 50, color: "#e3262b" },
      { offset: 50, width: 100, color: "#0a6fc0" },
      { offset: 150, width: 150, color: "#7fb955" },
    ]) {
      ctx.fillStyle = stripe.color;
      const x =
        ramp.direction === 1
          ? ramp.x + ramp.width - stripe.offset - stripe.width
          : ramp.x + stripe.offset;
      ctx.fillRect(x, ramp.y, stripe.width, ramp.height);
    }
    // Height cues stay inside the real footprint: no perspective offset that would
    // make the visible edge disagree with collisions or placement hit-testing.
    const lowX = ramp.direction === 1 ? ramp.x : ramp.x + ramp.width,
      highX = ramp.direction === 1 ? ramp.x + ramp.width : ramp.x;
    const shade = ctx.createLinearGradient?.(lowX, 0, highX, 0);
    if (shade) {
      shade.addColorStop(0, "#ffffff30");
      shade.addColorStop(0.7, "#00000008");
      shade.addColorStop(1, "#00000040");
      ctx.fillStyle = shade;
      ctx.fillRect(ramp.x, ramp.y, ramp.width, ramp.height);
    }
    ctx.fillStyle = "#10201755";
    for (const sideY of [ramp.y, ramp.y + ramp.height]) {
      const inside = sideY === ramp.y ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(lowX, sideY);
      ctx.lineTo(highX, sideY);
      ctx.lineTo(highX, sideY + inside * Math.max(12, 3 / scale));
      ctx.closePath();
      ctx.fill();
    }
    // The heavy edge is the vertical 50 mm end, opposite the low entrance.
    ctx.strokeStyle = "#273b2a";
    ctx.lineWidth = 3 / scale;
    ctx.beginPath();
    ctx.moveTo(highX, ramp.y);
    ctx.lineTo(highX, ramp.y + ramp.height);
    ctx.stroke();
    ctx.strokeStyle = "#ffffffcc";
    ctx.lineWidth = 2 / scale;
    for (const fraction of [0.24, 0.76]) {
      const y = ramp.y + ramp.height * fraction,
        centerX = ramp.x + ramp.width / 2;
      ctx.beginPath();
      ctx.moveTo(centerX - ramp.direction * 62, y);
      ctx.lineTo(centerX + ramp.direction * 62, y);
      ctx.moveTo(centerX + ramp.direction * 34, y - 28);
      ctx.lineTo(centerX + ramp.direction * 62, y);
      ctx.lineTo(centerX + ramp.direction * 34, y + 28);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = "#9aa0a6";
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([8 / scale, 6 / scale]);
  ctx.beginPath();
  ctx.moveTo(FIELD.midX, 0);
  ctx.lineTo(FIELD.midX, FIELD.height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = palette.frame;
  ctx.lineWidth = Math.max(12, 3 / scale);
  ctx.strokeRect(0, 0, FIELD.width, FIELD.height);
}

/** Readable height labels are drawn before robots and balls, so they never hide them. */
function drawRampHeights(ctx: CanvasRenderingContext2D, scale: number) {
  // At very distant zoom levels omit the badge instead of shrinking its text.
  if (FIELD.ramps[0].width * scale < 42) return;
  for (const ramp of FIELD.ramps) {
    ctx.save();
    ctx.translate(ramp.x + ramp.width / 2, ramp.y + ramp.height / 2);
    ctx.scale(1 / scale, -1 / scale);
    const text = ramp.direction === 1 ? `0 → ${ramp.elevation} mm` : `${ramp.elevation} ← 0 mm`;
    ctx.font = "600 14px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const textWidth = ctx.measureText?.(text)?.width ?? text.length * 8;
    ctx.fillStyle = "#ffffffea";
    roundedRect(ctx, -textWidth / 2 - 8, -13, textWidth + 16, 26, 6);
    ctx.fill();
    ctx.fillStyle = "#24352b";
    ctx.fillText(text, 0, 0.5);
    ctx.restore();
  }
}

function drawRestrictedZones(ctx: CanvasRenderingContext2D, scale: number, model: FieldModel) {
  ctx.save();
  for (const ramp of FIELD.ramps) {
    const x = ramp.direction === 1 ? ramp.x + ramp.width - 50 : ramp.x;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, ramp.y, 50, ramp.height);
    ctx.clip();
    ctx.strokeStyle = "#ffffffaa";
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    for (let y = ramp.y - 50; y < ramp.y + ramp.height; y += 30) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + 50, y + 50);
    }
    ctx.stroke();
    ctx.restore();
  }
  const team = model.scene.robots.find((robot) => robot.id === model.selectedRobot)?.team;
  if (team) {
    // Tint the selected robot's opponent half and point chevrons into it.
    const color = TEAM_COLORS[team];
    ctx.fillStyle = `${color}10`;
    ctx.fillRect(team === "A" ? FIELD.midX : 0, 0, FIELD.midX, FIELD.height);
    const direction = team === "A" ? 1 : -1;
    ctx.strokeStyle = `${color}99`;
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    for (let y = 90; y < FIELD.height; y += 180) {
      ctx.moveTo(FIELD.midX + direction * 12, y - 18);
      ctx.lineTo(FIELD.midX + direction * 32, y);
      ctx.lineTo(FIELD.midX + direction * 12, y + 18);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawRobot(
  ctx: CanvasRenderingContext2D,
  scale: number,
  robot: RobotConfig,
  pose: SimulationPose,
  model: FieldModel,
  palette: FieldPalette,
  colliding: boolean,
) {
  const selected = robot.id === model.selectedRobot,
    hovered = model.hover?.kind === "robot" && model.hover.id === robot.id,
    color = TEAM_COLORS[robot.team],
    px = 1 / scale;
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.heading * DEG);
  ctx.globalAlpha = robot.controller.kind === "disabled" ? 0.45 : 1;
  const left = -robot.length / 2,
    bottom = -robot.width / 2;
  if (selected || hovered) {
    ctx.save();
    ctx.strokeStyle = selected ? palette.accent : `${color}aa`;
    ctx.globalAlpha *= selected ? 0.35 : 0.25;
    ctx.lineWidth = 10 * px;
    roundedRect(
      ctx,
      left - 6 * px,
      bottom - 6 * px,
      robot.length + 12 * px,
      robot.width + 12 * px,
      14,
    );
    ctx.stroke();
    ctx.restore();
  }
  if (colliding) {
    ctx.save();
    ctx.strokeStyle = palette.warning;
    ctx.lineWidth = 3 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    roundedRect(
      ctx,
      left - 12 * px,
      bottom - 12 * px,
      robot.length + 24 * px,
      robot.width + 24 * px,
      18,
    );
    ctx.stroke();
    ctx.restore();
  }
  // Tyres sit under the chassis so only their tread pokes out.
  ctx.fillStyle = "#23292e";
  for (const wheel of robot.wheels) {
    ctx.save();
    ctx.translate(wheel.x, wheel.y);
    ctx.rotate(wheel.angle * DEG);
    roundedRect(ctx, -wheel.diameter / 2, -8, wheel.diameter, 16, 4);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = color;
  roundedRect(ctx, left, bottom, robot.length, robot.width, 12);
  ctx.fill();
  ctx.strokeStyle = selected ? palette.accent : "#0d1620";
  ctx.lineWidth = (selected ? 2.5 : 1.25) * px;
  ctx.stroke();
  // A lighter cab towards the front reads as "this way is forward" without the heading layer.
  ctx.fillStyle = "#ffffff38";
  roundedRect(
    ctx,
    robot.length * 0.05,
    bottom + robot.width * 0.18,
    robot.length * 0.35,
    robot.width * 0.64,
    8,
  );
  ctx.fill();
  if (robot.pusher) {
    ctx.fillStyle = "#7d8f9e";
    roundedRect(
      ctx,
      robot.length / 2,
      -robot.pusher.width / 2,
      robot.pusher.depth,
      robot.pusher.width,
      4,
    );
    ctx.fill();
    ctx.strokeStyle = "#0d1620";
    ctx.lineWidth = px;
    ctx.stroke();
  }
  if (robot.shooter) {
    ctx.save();
    ctx.translate(robot.shooter.x, robot.shooter.y);
    ctx.rotate(robot.shooter.angle * DEG);
    ctx.strokeStyle = "#ffd36b";
    ctx.lineCap = "round";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(-20, 0);
    ctx.lineTo(70, 0);
    ctx.stroke();
    ctx.restore();
  }
  if (model.layers.rays)
    for (const sensor of robot.sensors) {
      ctx.save();
      ctx.translate(sensor.x, sensor.y);
      ctx.rotate(sensor.angle * DEG);
      ctx.strokeStyle = "#2fc7a2cc";
      ctx.fillStyle = "#2fc7a21c";
      ctx.lineWidth = 1.5 * px;
      if (sensor.fov > 0 && sensor.range > 0) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, sensor.range, (-sensor.fov * DEG) / 2, (sensor.fov * DEG) / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (sensor.range > 0) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(sensor.range, 0);
        ctx.stroke();
      }
      ctx.fillStyle = "#2fc7a2";
      ctx.beginPath();
      ctx.arc(0, 0, 4 * px, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  if (model.layers.headings) {
    const front = robotExtents(robot).front;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#0d1620";
    ctx.lineWidth = px;
    ctx.beginPath();
    ctx.moveTo(front - 4 * px, -7 * px);
    ctx.lineTo(front + 10 * px, 0);
    ctx.lineTo(front - 4 * px, 7 * px);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawBall(
  ctx: CanvasRenderingContext2D,
  scale: number,
  ball: SimulationBall,
  model: FieldModel,
  palette: FieldPalette,
) {
  const r = FIELD.ballRadius,
    lift = Math.max(0, ball.z - r),
    selected = ball.id === model.selectedBall,
    hovered = model.hover?.kind === "ball" && model.hover.id === ball.id;
  // The shadow stays on the mat; the ball itself drifts up-right with height.
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0.08, 0.28 - lift / 4000)})`;
  ctx.beginPath();
  ctx.ellipse(
    ball.x + 3,
    ball.y - 3,
    r * (1 + lift / 1500),
    r * 0.8 * (1 + lift / 1500),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  const cx = ball.x + lift * 0.08,
    cy = ball.y + lift * 0.16;
  if (selected || hovered) {
    ctx.strokeStyle = selected ? palette.accent : "#00000055";
    ctx.lineWidth = (selected ? 3 : 2) / scale;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 7 / scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  const gradient = ctx.createRadialGradient?.(cx - r * 0.35, cy + r * 0.35, r * 0.1, cx, cy, r);
  const base = ball.kind === "orange" ? "#f28a1f" : "#8a55d4";
  if (gradient) {
    gradient.addColorStop(0, ball.kind === "orange" ? "#ffd3a1" : "#d8c2ff");
    gradient.addColorStop(0.45, base);
    gradient.addColorStop(1, ball.kind === "orange" ? "#a8540c" : "#4d2a86");
    ctx.fillStyle = gradient;
  } else ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Screen-space labels keep a fixed pixel size regardless of zoom. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: FieldCamera,
  model: FieldModel,
  palette: FieldPalette,
) {
  ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const robot of model.scene.robots) {
    const pose = livePose(model, robot);
    const extent = Math.hypot(robot.length, robot.width) / 2;
    const anchor = screenPoint(pose.x, pose.y - extent, width, height, camera);
    const text = robot.name.slice(0, 16);
    const textWidth = ctx.measureText?.(text)?.width ?? text.length * 6.5;
    const x = anchor.x,
      y = anchor.y + 14;
    ctx.fillStyle = palette.label;
    ctx.globalAlpha = 0.92;
    roundedRect(ctx, x - textWidth / 2 - 7, y - 9, textWidth + 14, 18, 9);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = TEAM_COLORS[robot.team];
    ctx.lineWidth = robot.id === model.selectedRobot ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = palette.text;
    ctx.fillText(text, x, y + 0.5);
  }
}

function drawHandle(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: FieldCamera,
  model: FieldModel,
  palette: FieldPalette,
) {
  const robot = model.scene.robots.find((item) => item.id === model.selectedRobot);
  if (!robot || !model.editable) return;
  const scale = fieldTransform(width, height, camera).scale;
  const pose = robot.pose,
    handle = rotationHandle(robot, pose, scale);
  const center = screenPoint(pose.x, pose.y, width, height, camera),
    point = screenPoint(handle.x, handle.y, width, height, camera);
  const hovered = model.hover?.kind === "handle";
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(point.x, point.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = hovered ? palette.accent : palette.label;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawField(
  ctx: CanvasRenderingContext2D,
  view: { width: number; height: number; dpr: number; camera: FieldCamera },
  palette: FieldPalette,
  model: FieldModel,
): void {
  const { width, height, dpr, camera } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  const transform = fieldTransform(width, height, camera);
  const scale = transform.scale;
  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(scale, -scale);
  drawMat(ctx, scale, palette);
  if (model.layers.restrictedZones) drawRestrictedZones(ctx, scale, model);
  ctx.fillStyle = "#6f5f4e";
  ctx.fillRect(FIELD.barrier.x, FIELD.barrier.y, FIELD.barrier.width, FIELD.barrier.height);
  drawRampHeights(ctx, scale);
  const snapshot = model.snapshot;
  if (model.layers.traces && snapshot)
    for (const robot of snapshot.robots) {
      const config = model.scene.robots.find((item) => item.id === robot.id);
      if (!config || robot.trace.length < 2) continue;
      ctx.strokeStyle = `${TEAM_COLORS[config.team]}99`;
      ctx.lineWidth = 3 / scale;
      ctx.lineJoin = "round";
      ctx.beginPath();
      robot.trace.forEach((point, index) =>
        index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y),
      );
      ctx.stroke();
    }
  const colliding = new Set(
    model.layers.collisions && snapshot
      ? snapshot.events
          .filter(
            (event) =>
              event.kind === "collision" &&
              event.timeMs <= snapshot.timeMs &&
              snapshot.timeMs - event.timeMs <= 1000,
          )
          .map((event) => event.robotId)
      : [],
  );
  for (const robot of model.scene.robots)
    drawRobot(ctx, scale, robot, livePose(model, robot), model, palette, colliding.has(robot.id));
  for (const ball of [...liveBalls(model)].sort((a, b) => a.z - b.z))
    drawBall(ctx, scale, ball, model, palette);
  ctx.restore();
  drawLabels(ctx, width, height, camera, model, palette);
  drawHandle(ctx, width, height, camera, model, palette);
}
