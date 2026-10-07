import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIXY2_CONFIG,
  type SimulationBall,
  type SimulationSensor,
} from "../shared/simulator.js";
import { ballOccludesCamera, pixy2Blocks } from "./pixy2-camera.js";

const sensor: SimulationSensor = {
  port: 4,
  kind: "pixy2",
  x: 0,
  y: 0,
  angle: 0,
  range: 2500,
  fov: 60,
  pixy2: { ...DEFAULT_PIXY2_CONFIG, pitch: 0 },
};
const camera = { x: 0, y: 0, z: 100, heading: 0 };
const ball = (
  id: string,
  x = 500,
  y = 0,
  z = 100,
  kind: SimulationBall["kind"] = "orange",
): SimulationBall => ({ id, x, y, z, kind });
const project = (balls: SimulationBall[], config = sensor, pose = camera) =>
  pixy2Blocks(config, pose, balls, 20, () => true);

describe("Pixy2 synthetic optics", () => {
  it("reports centered byte coordinates and larger bounds for nearer balls", () => {
    const blocks = project([ball("far", 1000), ball("near", 500, 0, 100, "purple")]);
    expect(blocks.map((block) => block.signature)).toEqual([2, 1]);
    expect(blocks[0]!.x).toBeGreaterThanOrEqual(126);
    expect(blocks[0]!.x).toBeLessThanOrEqual(128);
    expect(blocks[0]!.y).toBeGreaterThanOrEqual(126);
    expect(blocks[0]!.y).toBeLessThanOrEqual(128);
    expect(blocks[0]!.width).toBeGreaterThan(blocks[1]!.width);
    expect(blocks[0]!.height).toBeGreaterThan(blocks[1]!.height);
  });

  it("moves image coordinates right/down and respects camera heading and pitch", () => {
    const centre = project([ball("centre")])[0]!;
    const right = project([ball("right", 500, -100)])[0]!;
    const lower = project([ball("lower", 500, 0, 20)])[0]!;
    expect(right.x).toBeGreaterThan(centre.x);
    expect(lower.y).toBeGreaterThan(centre.y);
    const rotated = project([ball("rotated", 0, 500)], sensor, { ...camera, heading: 90 })[0]!;
    expect(rotated.x).toBeCloseTo(centre.x, 0);
    const downward = project([ball("ground", 500, 0, 20)], {
      ...sensor,
      pixy2: DEFAULT_PIXY2_CONFIG,
    })[0]!;
    expect(downward.y).toBeLessThan(lower.y);
    expect(project([ball("up", 500, 0, 500)])).toEqual([]);
  });

  it("clips edge detections and excludes behind-camera, distant and occluded targets", () => {
    const edge = project([ball("edge", 500, -290)])[0]!;
    expect(edge.x).toBeGreaterThan(245);
    expect(edge.width).toBeGreaterThan(0);
    expect(
      Object.values(edge).every((value) => Number.isInteger(value) && value >= 0 && value <= 255),
    ).toBe(true);
    expect(project([ball("outside", 500, -400), ball("behind", -500), ball("far", 3000)])).toEqual(
      [],
    );
    expect(pixy2Blocks(sensor, camera, [ball("hidden")], 20, () => false)).toEqual([]);
  });

  it("maps taught signatures, disables untrained colors and keeps ties deterministic", () => {
    const config = {
      ...sensor,
      pixy2: { ...DEFAULT_PIXY2_CONFIG, pitch: 0, orangeSignature: 7, purpleSignature: 0 },
    };
    expect(
      project([ball("orange"), ball("purple", 500, 0, 100, "purple")], config).map(
        (block) => block.signature,
      ),
    ).toEqual([7]);
    const equal = [ball("a", 500, 0, 100, "purple"), ball("b")];
    expect(project(equal)).toEqual(project([...equal].reverse()));
    expect(project(equal)[0]!.signature).toBe(2);
  });

  it("rejects off-axis balls near the lens plane instead of filling the image", () => {
    expect(project([ball("side", 1, 1000), ball("above", 1, 0, 1000)])).toEqual([]);
    const close = project([ball("close", 10)])[0]!;
    expect(close.width).toBe(255);
    expect(close.height).toBe(255);
  });

  it("accounts for a ball blocking another at the actual camera height", () => {
    const target = ball("target", 1000, 0, 100);
    expect(ballOccludesCamera(camera, target, ball("front"), 20)).toBe(true);
    expect(ballOccludesCamera(camera, target, ball("off-axis", 500, 50), 20)).toBe(false);
    expect(ballOccludesCamera(camera, target, ball("below", 500, 0, 20), 20)).toBe(false);
    expect(ballOccludesCamera(camera, target, ball("behind", 1200), 20)).toBe(false);
    expect(ballOccludesCamera(camera, target, target, 20)).toBe(false);
  });
});
