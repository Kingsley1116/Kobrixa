// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { SimulationScene } from "../../shared/simulator.js";
import {
  createDefaultScene,
  createPracticeScene,
  FIELD,
  PRACTICE_FIELD,
} from "../../simulation/scene.js";
import {
  drawField,
  type FieldLayers,
  type FieldPalette,
  fieldPoint,
  headingToward,
  normalizeHeading,
  pointInRobot,
  rotationHandle,
  zoomAt,
} from "./field-renderer.js";
import { LayersMenu } from "./layers-menu.js";
import { simulatorCopy } from "./simulator-copy.js";

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

type Call = { name: string; args: unknown[] };
/** Records every method call; property writes are kept and otherwise ignored. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return key === "measureText" ? { width: 40 } : undefined;
      };
    },
    set(target, key, value) {
      if (typeof key === "string") target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const palette: FieldPalette = {
  background: "#000",
  frame: "#123456",
  text: "#fff",
  muted: "#888",
  accent: "#00f",
  error: "#f00",
  warning: "#ff0",
  label: "#222",
};
const allLayers: FieldLayers = {
  traces: true,
  rays: true,
  headings: true,
  collisions: true,
  restrictedZones: true,
};

function render(scene: SimulationScene) {
  const { ctx, calls } = recordingContext();
  drawField(
    ctx,
    { width: 1200, height: 700, dpr: 1, camera: { zoom: 1, panX: 0, panY: 0 } },
    palette,
    {
      scene,
      snapshot: null,
      selectedRobot: scene.robots[0]!.id,
      selectedBall: null,
      hover: null,
      editable: true,
      layers: allLayers,
    },
  );
  return calls;
}
const isBarrier = (call: Call) =>
  call.name === "fillRect" &&
  call.args[0] === FIELD.barrier.x &&
  call.args[1] === FIELD.barrier.y &&
  call.args[2] === FIELD.barrier.width &&
  call.args[3] === FIELD.barrier.height;
const isRamp = (call: Call) =>
  call.name === "fillRect" &&
  FIELD.ramps.some((ramp) => call.args[1] === ramp.y && call.args[3] === ramp.height);

describe("drawField", () => {
  it("draws only the line loop and frame on the practice mat", () => {
    const calls = render(createPracticeScene());
    expect(calls.some(isBarrier)).toBe(false);
    expect(calls.some(isRamp)).toBe(false);
    // No restricted-zone hatching, even with the layer switched on.
    expect(calls.some((call) => call.name === "clip")).toBe(false);
    const { loop } = PRACTICE_FIELD;
    const start = calls.findIndex(
      (call) =>
        call.name === "moveTo" && call.args[0] === loop.x + loop.radius && call.args[1] === loop.y,
    );
    expect(start).toBeGreaterThan(0);
    expect(calls[start - 1]!.name).toBe("beginPath");
    const closed = calls.findIndex((call, index) => index > start && call.name === "closePath");
    expect(calls[closed + 1]!.name).toBe("stroke");
    expect(calls.some((call) => call.name === "strokeRect" && call.args[2] === FIELD.width)).toBe(
      true,
    );
  });

  it("still draws the barrier, ramps and restricted zones on the WRO mat", () => {
    const calls = render(createDefaultScene("main.bp"));
    expect(calls.some(isBarrier)).toBe(true);
    expect(calls.some(isRamp)).toBe(true);
    expect(calls.some((call) => call.name === "clip")).toBe(true);
  });
});

describe("LayersMenu", () => {
  async function open(practice?: boolean) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const onChange = vi.fn<(layers: FieldLayers) => void>();
    await act(async () =>
      root.render(
        createElement(LayersMenu, {
          t: simulatorCopy.en,
          locale: "en",
          layers: allLayers,
          onChange,
          ...(practice === undefined ? {} : { practice }),
        }),
      ),
    );
    await act(async () => element.querySelector<HTMLButtonElement>(".picker-trigger")!.click());
    const options = [...document.querySelectorAll<HTMLElement>("[data-picker-value]")];
    const cleanup = async () => {
      await act(async () => root.unmount());
      element.remove();
      vi.unstubAllGlobals();
    };
    return { options, onChange, cleanup };
  }

  it("offers restricted zones by default", async () => {
    const menu = await open();
    expect(menu.options.map((option) => option.dataset.pickerValue)).toContain("restrictedZones");
    await menu.cleanup();
  });

  it("hides restricted zones on the practice field and leaves its value alone", async () => {
    const menu = await open(true);
    expect(menu.options.map((option) => option.dataset.pickerValue)).not.toContain(
      "restrictedZones",
    );
    await act(async () =>
      menu.options.find((option) => option.dataset.pickerValue === "traces")!.click(),
    );
    expect(menu.onChange).toHaveBeenCalledWith({ ...allLayers, traces: false });
    await menu.cleanup();
  });
});
