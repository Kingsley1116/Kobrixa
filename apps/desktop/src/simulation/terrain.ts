import { FIELD } from "./scene.js";

/** Dimensions and coordinates are millimetres; direction is the uphill x direction. */
export interface RampGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly direction: 1 | -1;
  readonly elevation: number;
}

export interface TerrainPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Surface height along the ramp, clamped to its low and high ends. */
export function rampHeight(ramp: RampGeometry, x: number): number {
  const progress = Math.max(0, Math.min(1, (x - ramp.x) / ramp.width));
  return ramp.elevation * (ramp.direction === 1 ? progress : 1 - progress);
}

/** Highest solid surface at a mat coordinate, including shared solid boundaries. */
export function floorHeight(x: number, y: number): number {
  let elevation = 0;
  for (const ramp of FIELD.ramps) {
    if (x >= ramp.x && x <= ramp.x + ramp.width && y >= ramp.y && y <= ramp.y + ramp.height) {
      elevation = Math.max(elevation, rampHeight(ramp, x));
    }
  }
  const barrier = FIELD.barrier;
  if (
    x >= barrier.x &&
    x <= barrier.x + barrier.width &&
    y >= barrier.y &&
    y <= barrier.y + barrier.height
  ) {
    elevation = Math.max(elevation, barrier.elevation);
  }
  return elevation;
}

/**
 * First intersection of a finite 3D segment with the ramp's closed solid wedge.
 * Returns a normalized segment parameter in [0, 1], or undefined for no hit.
 * A segment starting inside the volume returns 0; touching its surface is a hit.
 */
export function intersectRampSegment(
  ramp: RampGeometry,
  origin: TerrainPoint,
  target: TerrainPoint,
): number | undefined {
  const slope = (ramp.direction * ramp.elevation) / ramp.width;
  const surfaceAtOriginX =
    slope * (origin.x - ramp.x) + (ramp.direction === 1 ? 0 : ramp.elevation);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;

  // Each pair describes a half-space: signedDistance + t * change <= 0.
  // Clipping against all six planes also handles vertical side/end faces.
  const planes: readonly (readonly [number, number])[] = [
    [ramp.x - origin.x, -dx],
    [origin.x - ramp.x - ramp.width, dx],
    [ramp.y - origin.y, -dy],
    [origin.y - ramp.y - ramp.height, dy],
    [-origin.z, -dz],
    [origin.z - surfaceAtOriginX, dz - slope * dx],
  ];
  let enter = 0;
  let leave = 1;
  for (const [distance, change] of planes) {
    if (Math.abs(change) < 1e-9) {
      if (distance > 1e-9) return undefined;
      continue;
    }
    const crossing = -distance / change;
    if (change < 0) enter = Math.max(enter, crossing);
    else leave = Math.min(leave, crossing);
    if (enter > leave) return undefined;
  }
  return enter;
}
