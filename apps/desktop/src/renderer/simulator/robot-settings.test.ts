// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulationScene } from "../../shared/simulator.js";
import { robotHardware } from "../../simulation/robot-presets.js";
import { createDefaultScene, createPracticeScene } from "../../simulation/scene.js";
import { RobotSettings } from "./robot-settings.js";
import { simulatorCopy } from "./simulator-copy.js";

const t = simulatorCopy.en;

function render(scene: SimulationScene) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const onChange = vi.fn<(scene: SimulationScene) => void>();
  act(() =>
    root.render(
      createElement(RobotSettings, {
        locale: "en",
        scene,
        robot: scene.robots[0]!,
        entries: ["src/main.bp"],
        onChange,
        disabled: false,
        t,
      }),
    ),
  );
  const trigger = (label: string) =>
    element.querySelector<HTMLButtonElement>(`.picker-trigger[aria-label="${label}"]`)!;
  const open = (label: string) => {
    act(() => trigger(label).click());
    return [...document.querySelectorAll<HTMLElement>("[data-picker-value]")];
  };
  const choose = (label: string, value: string) => {
    const option = open(label).find((option) => option.dataset.pickerValue === value);
    expect(option).toBeDefined();
    act(() => option!.click());
  };
  const cleanup = () => {
    act(() => root.unmount());
    element.remove();
  };
  return { element, onChange, trigger, open, choose, cleanup };
}
const changed = (onChange: ReturnType<typeof render>["onChange"]) =>
  onChange.mock.lastCall![0].robots[0]!;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("robot settings", () => {
  it("applies a preset's hardware and keeps identity, controller and pose", () => {
    const scene = createPracticeScene("src/main.bp");
    const robot = scene.robots[0]!;
    const h = render(scene);
    try {
      expect(h.trigger(t.preset).textContent).toContain(t.presetDrivingBase);
      h.choose(t.preset, "wro");
      const next = changed(h.onChange);
      expect(next).toMatchObject(robotHardware("wro"));
      expect(next.id).toBe(robot.id);
      expect(next.controller).toEqual(robot.controller);
      expect(next.pose).toEqual(robot.pose);
    } finally {
      h.cleanup();
    }
  });

  it("shows a non-selectable Custom preset for modified hardware", () => {
    const scene = createPracticeScene("src/main.bp");
    scene.robots[0]!.mass = 0.5;
    const h = render(scene);
    try {
      expect(h.trigger(t.preset).textContent).toContain(t.presetCustom);
      const custom = h.open(t.preset).find((option) => option.dataset.pickerValue === "custom")!;
      expect(custom.getAttribute("aria-disabled")).toBe("true");
      act(() => custom.click());
      expect(h.onChange).not.toHaveBeenCalled();
    } finally {
      h.cleanup();
    }
  });

  it("edits sensors per port", () => {
    const scene = createPracticeScene("src/main.bp");
    const touch = scene.robots[0]!.sensors.find((sensor) => sensor.port === 1)!;
    const h = render(scene);
    try {
      h.choose(t.sensorPort(3), "none");
      expect(changed(h.onChange).sensors.some((sensor) => sensor.port === 3)).toBe(false);
      h.choose(t.sensorPort(1), "ultrasonic");
      const port1 = changed(h.onChange).sensors.find((sensor) => sensor.port === 1)!;
      expect(port1).toMatchObject({ kind: "ultrasonic", x: touch.x, y: touch.y, range: 2500 });
    } finally {
      h.cleanup();
    }
  });

  it("adds a sensor on an empty port at the front centre", () => {
    const scene = createPracticeScene("src/main.bp");
    const robot = scene.robots[0]!;
    robot.sensors = robot.sensors.filter((sensor) => sensor.port !== 2);
    const h = render(scene);
    try {
      expect(h.trigger(t.sensorPort(2)).textContent).toContain(t.noSensor);
      h.choose(t.sensorPort(2), "pixy2");
      const port2 = changed(h.onChange).sensors.find((sensor) => sensor.port === 2)!;
      expect(port2).toMatchObject({ kind: "pixy2", x: robot.length / 2, y: 0, fov: 60 });
      expect(port2.pixy2).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it("edits left and right drive motor ports", () => {
    const scene = createPracticeScene("src/main.bp");
    const h = render(scene);
    try {
      expect(h.trigger(t.driveLeft).textContent).toContain("B");
      expect(h.trigger(t.driveRight).textContent).toContain("C");
      h.choose(t.driveRight, "D");
      expect(changed(h.onChange).wheels.map((wheel) => wheel.port)).toEqual(["B", "D"]);
    } finally {
      h.cleanup();
    }
  });

  it("hides opponents and team on the practice field", () => {
    const h = render(createPracticeScene("src/main.bp"));
    try {
      expect(h.element.querySelector(`#sim-team-A1`)).toBeNull();
      const values = h.open(t.controller).map((option) => option.dataset.pickerValue);
      expect(values.some((value) => value?.startsWith("builtin:"))).toBe(false);
      expect(values).toContain("disabled");
    } finally {
      h.cleanup();
    }
  });

  it("keeps opponents and team on the WRO field", () => {
    const scene = createDefaultScene("src/main.bp");
    const h = render(scene);
    try {
      expect(h.element.querySelector(`#sim-team-${scene.robots[0]!.id}`)).not.toBeNull();
      const values = h.open(t.controller).map((option) => option.dataset.pickerValue);
      expect(values.filter((value) => value?.startsWith("builtin:"))).toHaveLength(3);
    } finally {
      h.cleanup();
    }
  });

  it("collapses advanced settings by default", () => {
    const h = render(createPracticeScene("src/main.bp"));
    try {
      const advanced = h.element.querySelector<HTMLDetailsElement>("details.sim-advanced")!;
      expect(advanced.open).toBe(false);
      expect(advanced.querySelector("summary")!.textContent).toBe(t.advanced);
      expect(advanced.querySelector('[aria-label="Drive"]')).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
