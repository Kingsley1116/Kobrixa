import {
  DEFAULT_PIXY2_CONFIG,
  type Pixy2Block,
  type SimulationBall,
  type SimulationSensor,
} from "../shared/simulator.js";

const DEG = Math.PI / 180;
/** Native image size and LEGO firmware byte-coordinate scaling. */
export const PIXY2_FRAME = {
  width: 316,
  height: 208,
  scaleX: 829 / 1024,
  scaleY: 1262 / 1024,
} as const;
const WIDTH = PIXY2_FRAME.width;
const HEIGHT = PIXY2_FRAME.height;

export interface Pixy2CameraPose {
  x: number;
  y: number;
  z: number;
  heading: number;
}

/** A sphere's projected bounds, clipped to the image. Pixel coordinates are synthetic. */
function bounds(axis: number, depth: number, radius: number, focal: number, size: number) {
  const angle = Math.atan2(axis, depth);
  const extent = Math.asin(Math.min(1, radius / Math.hypot(axis, depth)));
  const halfView = Math.atan(size / 2 / focal);
  const first = Math.max(-halfView, angle - extent);
  const last = Math.min(halfView, angle + extent);
  if (first >= last) return null;
  const low = size / 2 + focal * Math.tan(first);
  const high = size / 2 + focal * Math.tan(last);
  return [Math.max(0, Math.floor(low)), Math.min(size - 1, Math.ceil(high))] as const;
}

/**
 * Approximate CCC detection of the scene's taught balls, using a pinhole camera.
 * Output uses LEGO's byte coordinates, not the regular Pixy2 serial packet layout.
 * Field scaling follows lego_getData in the manufacturer's serial.cpp:
 * https://github.com/charmedlabs/pixy2/blob/master/src/device/main_m4/src/serial.cpp
 */
export function pixy2Blocks(
  sensor: SimulationSensor,
  camera: Pixy2CameraPose,
  balls: readonly SimulationBall[],
  radius: number,
  visible: (ball: SimulationBall) => boolean,
): Pixy2Block[] {
  const config = sensor.pixy2 ?? DEFAULT_PIXY2_CONFIG;
  const heading = camera.heading * DEG;
  const pitch = config.pitch * DEG;
  const focalX = WIDTH / 2 / Math.tan((sensor.fov * DEG) / 2);
  const focalY = HEIGHT / 2 / Math.tan((config.verticalFov * DEG) / 2);
  const candidates: Array<{ id: string; area: number; block: Pixy2Block }> = [];
  for (const ball of balls) {
    const signature = ball.kind === "orange" ? config.orangeSignature : config.purpleSignature;
    if (!signature) continue;
    const dx = ball.x - camera.x,
      dy = ball.y - camera.y,
      dz = ball.z - camera.z;
    if (Math.hypot(dx, dy, dz) > sensor.range) continue;
    const forward = dx * Math.cos(heading) + dy * Math.sin(heading);
    const right = dx * Math.sin(heading) - dy * Math.cos(heading);
    const depth = forward * Math.cos(pitch) + dz * Math.sin(pitch);
    const down = forward * Math.sin(pitch) - dz * Math.cos(pitch);
    if (depth <= 0) continue;
    const horizontal = bounds(right, depth, radius, focalX, WIDTH);
    const vertical = bounds(down, depth, radius, focalY, HEIGHT);
    if (!horizontal || !vertical || !visible(ball)) continue;
    const width = horizontal[1] - horizontal[0];
    const height = vertical[1] - vertical[0];
    if (width <= 0 || height <= 0) continue;
    const scaleX = (value: number) => Math.min(255, Math.floor(value * PIXY2_FRAME.scaleX));
    const scaleY = (value: number) => Math.min(255, Math.floor(value * PIXY2_FRAME.scaleY));
    candidates.push({
      id: ball.id,
      area: width * height,
      block: {
        signature,
        x: scaleX(horizontal[0] + Math.floor(width / 2)),
        y: scaleY(vertical[0] + Math.floor(height / 2)),
        width: Math.max(1, scaleX(width)),
        height: Math.max(1, scaleY(height)),
      },
    });
  }
  candidates.sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates.map(({ block }) => block);
}

/** Centre-ray sphere occlusion; partial overlaps remain separate CCC blocks. */
export function ballOccludesCamera(
  camera: Pixy2CameraPose,
  target: SimulationBall,
  obstacle: SimulationBall,
  radius: number,
): boolean {
  if (target.id === obstacle.id) return false;
  const dx = target.x - camera.x,
    dy = target.y - camera.y,
    dz = target.z - camera.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) return false;
  const t =
    ((obstacle.x - camera.x) * dx + (obstacle.y - camera.y) * dy + (obstacle.z - camera.z) * dz) /
    lengthSquared;
  if (t <= 0 || t >= 1) return false;
  return (
    Math.hypot(
      camera.x + t * dx - obstacle.x,
      camera.y + t * dy - obstacle.y,
      camera.z + t * dz - obstacle.z,
    ) < radius
  );
}
