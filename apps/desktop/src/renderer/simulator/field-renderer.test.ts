import { describe, expect, it } from "vitest";
import { createDefaultScene } from "../../simulation/scene.js";
import {
  fieldPoint,
  headingToward,
  normalizeHeading,
  pointInRobot,
  rotationHandle,
  zoomAt,
} from "./field-renderer.js";

describe("field geometry", () => {
  it("keeps the field point under the pointer fixed while zooming", () => {
    const camera = { zoom: 1.3, panX: 25, panY: -40 };
    const before = fieldPoint(612, 143, 900, 500, camera);
    for (const factor of [1.25, 0.8, 3]) {
      const next = zoomAt(camera, 900, 500, 612, 143, factor);
      const after = fieldPoint(612, 143, 900, 500, next);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    }
  });

  it("clamps zoom to its limits", () => {
    expect(zoomAt({ zoom: 1, panX: 0, panY: 0 }, 900, 500, 0, 0, 1000).zoom).toBe(8);
    expect(zoomAt({ zoom: 1, panX: 0, panY: 0 }, 900, 500, 0, 0, 0.001).zoom).toBe(0.4);
  });

  it("hit-tests robots as rotated rectangles including the pusher", () => {
    const robot = {
      ...createDefaultScene("main.bp").robots[0]!,
      length: 200,
      width: 100,
      pusher: { width: 100, depth: 40 },
    };
    const pose = { x: 1000, y: 500, heading: 90 };
    // Facing +y: the long axis and the pusher now extend vertically.
    expect(pointInRobot(robot, pose, { x: 1000, y: 630 })).toBe(true);
    expect(pointInRobot(robot, pose, { x: 1000, y: 405 })).toBe(true);
    expect(pointInRobot(robot, pose, { x: 1000, y: 395 })).toBe(false);
    expect(pointInRobot(robot, pose, { x: 1080, y: 500 })).toBe(false);
    expect(pointInRobot(robot, pose, { x: 1080, y: 500 }, 40)).toBe(true);
  });

  it("places the rotation handle ahead of the robot and snaps dragged headings", () => {
    const robot = { ...createDefaultScene("main.bp").robots[0]!, length: 200, pusher: null };
    const handle = rotationHandle(robot, { x: 500, y: 500, heading: 0 }, 0.5);
    expect(handle.y).toBeCloseTo(500);
    expect(handle.x).toBeCloseTo(500 + 100 + 26 / 0.5);
    expect(headingToward({ x: 0, y: 0 }, { x: 10, y: 10.6 }, false)).toBeCloseTo(46.7, 1);
    expect(headingToward({ x: 0, y: 0 }, { x: 10, y: 10.6 }, true)).toBe(45);
    expect(headingToward({ x: 0, y: 0 }, { x: -10, y: -0.1 }, true)).toBe(180);
  });

  it("normalizes headings into (-180, 180]", () => {
    expect(normalizeHeading(190)).toBe(-170);
    expect(normalizeHeading(-180)).toBe(180);
    expect(normalizeHeading(720)).toBe(0);
  });
});
