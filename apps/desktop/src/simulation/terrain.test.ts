import { describe, expect, it } from "vitest";
import { FIELD } from "./scene.js";
import { floorHeight, intersectRampSegment, rampHeight } from "./terrain.js";

describe.each(FIELD.ramps)("ramp volume at x=$x, direction=$direction", (ramp) => {
  // Coordinates measured from the low end, independent of its world direction.
  const x = (progress: number) =>
    ramp.x + ramp.width * (ramp.direction === 1 ? progress : 1 - progress);
  const y = ramp.y + ramp.height / 2;

  it("has the official 300 mm run and 50 mm rise with clamped end heights", () => {
    expect(ramp.width).toBe(300);
    expect(ramp.height).toBe(563);
    expect(rampHeight(ramp, x(-1))).toBe(0);
    expect(rampHeight(ramp, x(0))).toBe(0);
    expect(rampHeight(ramp, x(0.5))).toBe(25);
    expect(rampHeight(ramp, x(1))).toBe(50);
    expect(rampHeight(ramp, x(2))).toBe(50);
    expect(floorHeight(x(0.5), y)).toBe(25);
    expect(floorHeight(x(-0.01), y)).toBe(0);
    expect(floorHeight(x(1.01), y)).toBe(0);
  });

  it("hits the sloping top when approaching from the low end", () => {
    const t = intersectRampSegment(ramp, { x: x(-0.5), y, z: 25 }, { x: x(1.5), y, z: 25 });
    expect(t).toBeCloseTo(0.5);
  });

  it("hits the high vertical end before reaching the sloping top", () => {
    const t = intersectRampSegment(ramp, { x: x(1.5), y, z: 25 }, { x: x(-0.5), y, z: 25 });
    expect(t).toBeCloseTo(0.25);
  });

  it("hits both vertical sides only below their local surface height", () => {
    for (const direction of [-1, 1]) {
      const originY = direction === 1 ? ramp.y - 100 : ramp.y + ramp.height + 100;
      const targetY = originY + direction * 200;
      expect(
        intersectRampSegment(
          ramp,
          { x: x(0.5), y: originY, z: 20 },
          { x: x(0.5), y: targetY, z: 20 },
        ),
      ).toBeCloseTo(0.5);
      expect(
        intersectRampSegment(
          ramp,
          { x: x(0.5), y: originY, z: 30 },
          { x: x(0.5), y: targetY, z: 30 },
        ),
      ).toBeUndefined();
    }
  });

  it("hits the top from above and the base from below", () => {
    expect(
      intersectRampSegment(ramp, { x: x(0.5), y, z: 100 }, { x: x(0.5), y, z: 0 }),
    ).toBeCloseTo(0.75);
    expect(
      intersectRampSegment(ramp, { x: x(0.5), y, z: -20 }, { x: x(0.5), y, z: 20 }),
    ).toBeCloseTo(0.5);
  });

  it("returns the segment start for points inside or on the surface", () => {
    for (const z of [0, 20, 25]) {
      const point = { x: x(0.5), y, z };
      expect(intersectRampSegment(ramp, point, point)).toBe(0);
      expect(intersectRampSegment(ramp, point, { x: x(2), y, z: 100 })).toBe(0);
    }
  });

  it("allows segments above, below, or beside the solid to pass", () => {
    for (const z of [-1, 51]) {
      expect(intersectRampSegment(ramp, { x: x(-0.5), y, z }, { x: x(1.5), y, z })).toBeUndefined();
    }
    expect(
      intersectRampSegment(
        ramp,
        { x: x(-0.5), y: ramp.y - 1, z: 20 },
        { x: x(1.5), y: ramp.y - 1, z: 20 },
      ),
    ).toBeUndefined();
  });

  it("does not extend a segment beyond its target", () => {
    expect(
      intersectRampSegment(ramp, { x: x(2), y, z: 20 }, { x: x(1.1), y, z: 20 }),
    ).toBeUndefined();
    expect(
      intersectRampSegment(ramp, { x: x(1.1), y, z: 20 }, { x: x(2), y, z: 20 }),
    ).toBeUndefined();
  });
});

describe("field surface height", () => {
  it("includes the barrier and chooses the higher surface at shared boundaries", () => {
    expect(floorHeight(FIELD.midX, FIELD.midY)).toBe(50);
    expect(floorHeight(1031, FIELD.barrier.y)).toBe(50);
    expect(floorHeight(1331, FIELD.barrier.y + FIELD.barrier.height)).toBe(50);
    expect(floorHeight(200, 200)).toBe(0);
  });
});
