import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIXY2_CONFIG,
  type SimulationBall,
  type SimulationSensor,
} from "../shared/simulator.js";
import { pixy2Blocks } from "./pixy2-camera.js";
import { pixy2Observation } from "./pixy2-observation.js";
import { Pixy2Protocol } from "./pixy2-protocol.js";

const sensor: SimulationSensor = {
  port: 1,
  kind: "pixy2",
  x: 0,
  y: 0,
  angle: 0,
  range: 2500,
  fov: 60,
  pixy2: { ...DEFAULT_PIXY2_CONFIG, pitch: 0 },
};

function project(
  target: { x: number; y: number; z: number },
  mount: SimulationSensor = sensor,
  visible = true,
  radius = 20,
) {
  const ball: SimulationBall = { id: "target", kind: "orange", ...target };
  const config = mount.pixy2 ?? DEFAULT_PIXY2_CONFIG;
  const blocks = pixy2Blocks(
    mount,
    { x: mount.x, y: mount.y, z: config.height, heading: mount.angle },
    [ball],
    radius,
    () => visible,
  );
  const reply = new Pixy2Protocol().exchange([0x50 + config.orangeSignature], 5, blocks);
  return { reply, observation: pixy2Observation(mount, reply, radius) };
}

describe("Pixy2 measurements for the built-in controller", () => {
  it.each([200, 500, 1000, 1800])(
    "recovers a %i mm sphere distance through the real LEGO wire format",
    (x) => {
      const { observation } = project({ x, y: 0, z: 100 });
      expect(observation).toBeDefined();
      // Distant balls occupy only a few pixels; the wire measurement cannot supply exact range.
      const tolerance = x < 1500 ? 0.08 : 0.12;
      expect(Math.abs(observation!.distance - x)).toBeLessThan(x * tolerance);
      expect(Math.abs(observation!.local.x - x)).toBeLessThan(x * tolerance);
      expect(Math.abs(observation!.local.y)).toBeLessThan(x * 0.01);
      expect(observation!.bearing).toBeCloseTo(0, 0);
      expect(observation!.reliable).toBe(true);
    },
  );

  it.each([-180, 180])("keeps left/right signs for a ball at y=%i", (y) => {
    const { observation } = project({ x: 500, y, z: 100 });
    expect(observation!.bearing).toBeCloseTo((Math.atan2(y, 500) * 180) / Math.PI, 0);
    expect(Math.abs(observation!.local.y - y)).toBeLessThan(12);
    expect(Math.abs(observation!.local.x - 500)).toBeLessThan(30);
    expect(observation!.reliable).toBe(true);
  });

  it.each([20, 140])(
    "undoes camera pitch, offset and mounting angle without assuming ball height (%i mm)",
    (z) => {
      const mount: SimulationSensor = {
        ...sensor,
        x: 65,
        y: 18,
        angle: 25,
        fov: 120,
        pixy2: { ...DEFAULT_PIXY2_CONFIG, pitch: -10 },
      };
      const target = { x: 700, y: 180, z };
      const { observation } = project(target, mount);
      const expectedDistance = Math.hypot(target.x - mount.x, target.y - mount.y);
      expect(observation).toBeDefined();
      expect(Math.abs(observation!.distance - expectedDistance)).toBeLessThan(
        expectedDistance * 0.06,
      );
      expect(Math.abs(observation!.local.x - target.x)).toBeLessThan(40);
      expect(Math.abs(observation!.local.y - target.y)).toBeLessThan(15);
      expect(observation!.bearing).toBeCloseTo(
        (Math.atan2(target.y - mount.y, target.x - mount.x) * 180) / Math.PI - mount.angle,
        0,
      );
      expect(observation!.reliable).toBe(true);
    },
  );

  it("uses default camera settings when an older scene omits them", () => {
    const mount = { ...sensor, pixy2: undefined };
    const { observation } = project({ x: 500, y: 0, z: 20 }, mount);
    expect(observation!.distance).toBeGreaterThan(470);
    expect(observation!.distance).toBeLessThan(530);
  });

  it.each([
    { x: 500, y: -290, z: 100 },
    { x: 500, y: 290, z: 100 },
    { x: 500, y: 0, z: 280 },
    { x: 500, y: 0, z: -80 },
    { x: 10, y: 0, z: 100 },
  ])("retains clipped blocks for steering but never precise shot positioning: %j", (target) => {
    const { observation } = project(target);
    expect(observation).toBeDefined();
    expect(observation!.reliable).toBe(false);
    expect(Number.isFinite(observation!.distance)).toBe(true);
    expect(Number.isFinite(observation!.local.x)).toBe(true);
    if (target.y) expect(Math.sign(observation!.bearing)).toBe(Math.sign(target.y));
  });

  it("uses an unclipped axis for range when the horizontal frame truncates the ball", () => {
    const target = { x: 500, y: -290, z: 100 };
    const { observation } = project(target);
    expect(Math.abs(observation!.distance - Math.hypot(target.x, target.y))).toBeLessThan(40);
  });

  it("does not promise precise positioning from tiny blocks", () => {
    const observation = pixy2Observation(sensor, [1, 127, 128, 2, 3]);
    expect(observation).toBeDefined();
    expect(observation!.reliable).toBe(false);
  });

  it("does not infer a target when the public detection is empty or occluded", () => {
    expect(project({ x: 500, y: 0, z: 100 }, sensor, false).observation).toBeUndefined();
    expect(project({ x: -500, y: 0, z: 100 }).observation).toBeUndefined();
    expect(pixy2Observation(sensor, [0, 0, 0, 0, 0])).toBeUndefined();
  });

  it.each(
    [
      [],
      [1, 127, 128, 10],
      [1, 127, 128, 10, 10, 0],
      [0, 127, 128, 10, 10],
      [1, 127, 128, 0, 10],
      [1, 127, 128, 10, 0],
      [1, -1, 128, 10, 10],
      [1, 127, 256, 10, 10],
      [1, 127.5, 128, 10, 10],
      [1, 127, Number.NaN, 10, 10],
    ].map((reply) => ({ reply })),
  )("rejects malformed or absent detections: $reply", ({ reply }) => {
    expect(pixy2Observation(sensor, reply)).toBeUndefined();
  });

  it("uses the specified known sphere radius", () => {
    const { observation } = project({ x: 500, y: 50, z: 100 }, sensor, true, 40);
    expect(Math.abs(observation!.local.x - 500)).toBeLessThan(20);
    expect(Math.abs(observation!.local.y - 50)).toBeLessThan(5);
  });

  it.each([
    { ...sensor, kind: "vision" as const },
    { ...sensor, fov: 0 },
    { ...sensor, fov: 180 },
    { ...sensor, range: 0 },
    { ...sensor, x: Number.NaN },
    { ...sensor, pixy2: { ...DEFAULT_PIXY2_CONFIG, verticalFov: 180 } },
  ])("rejects unusable camera configuration: %j", (mount) => {
    expect(pixy2Observation(mount, [1, 127, 128, 10, 10])).toBeUndefined();
  });
});
