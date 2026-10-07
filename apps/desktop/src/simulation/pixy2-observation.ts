import { DEFAULT_PIXY2_CONFIG, type SimulationSensor } from "../shared/simulator.js";
import { PIXY2_FRAME } from "./pixy2-camera.js";

const DEG = Math.PI / 180;

export interface Pixy2Observation {
  /** Estimated ball centre in robot-local millimetres: x forward, y left. */
  local: { x: number; y: number };
  /** Bearing relative to the camera's mounted horizontal direction, positive left. */
  bearing: number;
  /** Planar distance from the camera to the estimated centre, in millimetres. */
  distance: number;
  /** False for clipped or too-small blocks: usable for steering, not precise shot positioning. */
  reliable: boolean;
}

function axis(centerByte: number, spanByte: number, size: number, scale: number, fov: number) {
  const focal = size / 2 / Math.tan((fov * DEG) / 2);
  // Native coordinates are integers before firmware scaling. Use the midpoint of the
  // possible integer pixels, then restore the half pixel lost for odd bounding widths.
  const nativeInterval = (byte: number): [number, number] => [
    Math.ceil(byte / scale),
    Math.min(size - 1, Math.ceil((byte + 1) / scale) - 1),
  ];
  const [spanLow, spanHigh] = nativeInterval(spanByte);
  const measuredSpan = (spanLow + spanHigh) / 2;
  const halfPixel = spanLow === spanHigh ? (spanLow % 2) / 2 : 0.25;
  const [centerLow, centerHigh] = nativeInterval(centerByte);
  const center = (centerLow + centerHigh) / 2 + halfPixel;
  const clipped = center - measuredSpan / 2 <= 2 || center + measuredSpan / 2 >= size - 3;
  // The camera rounds bounding edges outwards. Removing their mean one-pixel expansion
  // avoids systematically putting small/distant balls closer than their measured diameter.
  const span = Math.max(0.5, measuredSpan - 1);
  const first = Math.atan((center - span / 2 - size / 2) / focal);
  const last = Math.atan((center + span / 2 - size / 2) / focal);
  const angle = (first + last) / 2;
  return {
    tangent: Math.tan(angle),
    depthPerRadius: Math.cos(angle) / Math.sin((last - first) / 2),
    weight: span * span,
    span,
    clipped,
  };
}

/**
 * Estimate a known-size sphere from a LEGO signature reply [count, x, y, width, height].
 * This uses only the public camera measurement and the mounted camera configuration.
 * The caller selects a uniquely taught signature; this function never guesses ball color.
 */
export function pixy2Observation(
  sensor: SimulationSensor,
  reply: readonly number[],
  radius = 20,
): Pixy2Observation | undefined {
  const config = sensor.pixy2 ?? DEFAULT_PIXY2_CONFIG;
  if (
    sensor.kind !== "pixy2" ||
    reply.length !== 5 ||
    reply.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
    reply[0] === 0 ||
    reply[3] === 0 ||
    reply[4] === 0 ||
    ![
      sensor.x,
      sensor.y,
      sensor.angle,
      sensor.range,
      sensor.fov,
      config.pitch,
      config.verticalFov,
      radius,
    ].every(Number.isFinite) ||
    sensor.range <= 0 ||
    radius <= 0 ||
    sensor.fov <= 0 ||
    sensor.fov >= 180 ||
    config.verticalFov <= 0 ||
    config.verticalFov >= 180
  )
    return undefined;

  const horizontal = axis(reply[1]!, reply[3]!, PIXY2_FRAME.width, PIXY2_FRAME.scaleX, sensor.fov);
  const vertical = axis(
    reply[2]!,
    reply[4]!,
    PIXY2_FRAME.height,
    PIXY2_FRAME.scaleY,
    config.verticalFov,
  );
  // An unclipped axis still gives useful range when the other axis touches the image edge.
  // If both are clipped, retain only an approximate observation for steering/avoidance.
  const axes = [horizontal, vertical];
  const complete = axes.filter((value) => !value.clipped);
  const measurements = complete.length ? complete : axes;
  const depth =
    (radius * measurements.reduce((sum, value) => sum + value.depthPerRadius * value.weight, 0)) /
    measurements.reduce((sum, value) => sum + value.weight, 0);
  const right = horizontal.tangent * depth;
  const down = vertical.tangent * depth;
  const pitch = config.pitch * DEG;
  const forward = depth * Math.cos(pitch) + down * Math.sin(pitch);
  const bearing = Math.atan2(-right, forward) / DEG;
  const distance = Math.hypot(forward, right);
  const mounted = (sensor.angle + bearing) * DEG;
  const local = {
    x: sensor.x + distance * Math.cos(mounted),
    y: sensor.y + distance * Math.sin(mounted),
  };
  if (![local.x, local.y, bearing, distance].every(Number.isFinite) || distance <= 0)
    return undefined;
  return {
    local,
    bearing,
    distance,
    reliable:
      !horizontal.clipped && !vertical.clipped && Math.max(horizontal.span, vertical.span) >= 6,
  };
}
