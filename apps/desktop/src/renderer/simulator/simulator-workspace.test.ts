// @vitest-environment jsdom
import { act, createElement, useState, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PreparedSimulation,
  SimulationCommand,
  SimulationResponse,
  SimulationScene,
  SimulationSnapshot,
} from "../../shared/simulator.js";
import { VirtualDevice } from "../../preview/virtual-device.js";
import type { IRInstruction, KobrixaIR } from "@kobrixa/ir";
import {
  createDefaultScene,
  createPracticeScene,
  FIELD,
  validateScene,
} from "../../simulation/scene.js";
import { fieldPoint, fieldTransform } from "./field-canvas.js";
import { SimulatorWorkspace } from "./simulator-workspace.js";

class UiWorker {
  static instances: UiWorker[] = [];
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  commands: SimulationCommand[] = [];
  terminated = false;
  snapshot: SimulationSnapshot = {
    status: "ready",
    timeMs: 0,
    robots: [],
    balls: [],
    score: { A: 0, B: 0 },
    events: [],
    practiceContinuation: false,
  };
  constructor() {
    UiWorker.instances.push(this);
  }
  postMessage(command: SimulationCommand) {
    this.commands.push(command);
    if (command.type === "load")
      this.snapshot = {
        ...this.snapshot,
        robots: command.scene.robots.map((robot) => ({
          id: robot.id,
          pose: robot.pose,
          distance: 0,
          elevation: 0,
          trace: [],
          status: "ready",
        })),
        balls: command.scene.balls,
      };
    if (command.type === "run") this.snapshot = { ...this.snapshot, status: "running" };
    if (command.type === "pause") this.snapshot = { ...this.snapshot, status: "paused" };
    if (command.type === "step")
      this.snapshot = { ...this.snapshot, status: "paused", timeMs: this.snapshot.timeMs + 10 };
    if (command.type === "stop") this.snapshot = { ...this.snapshot, status: "stopped" };
    if (command.type === "reset") this.snapshot = { ...this.snapshot, status: "ready", timeMs: 0 };
    this.onmessage?.({
      data: { type: "snapshot", snapshot: this.snapshot },
    } as MessageEvent<SimulationResponse>);
  }
  terminate() {
    this.terminated = true;
  }
}
function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", UiWorker);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const clearCanvas = vi.fn(),
    paintCanvas = vi.fn();
  const context = new Proxy(
    {
      clearRect: clearCanvas,
      putImageData: paintCanvas,
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    } as Record<string, unknown>,
    { get: (target, key: string) => target[key] ?? (() => {}) },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  return {
    root,
    element,
    clearCanvas,
    paintCanvas,
    button: (name: string) =>
      element.querySelector<HTMLButtonElement>(`[data-testid="simulator-${name}"]`)!,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  UiWorker.instances = [];
});

describe("local simulator workspace", () => {
  it.each([
    [
      "en",
      "Project program",
      "Built-in opponent",
      "Easy",
      "Standard",
      "Hard",
      "Running",
      "Setup",
      "Disabled",
    ],
    ["zh-TW", "專案程式", "內建對手", "簡易", "標準", "困難", "執行中", "設定中", "停用"],
  ] as const)(
    "identifies the actual program or opponent level separately from run state in %s",
    async (locale, program, builtin, easy, standard, hard, running, ready, disabled) => {
      const h = setup(),
        save = vi.fn(),
        prepare = vi.fn(async () => ({ programs: {} }));
      const entry = "competition/left/Main_Simple_L_2026.bp";
      const scene = createDefaultScene(entry);
      scene.robots[1]!.controller = { kind: "builtin", level: "easy" };
      scene.robots[2]!.controller = { kind: "builtin" };
      scene.robots[3]!.controller = { kind: "builtin", level: "hard" };
      const props = {
        entries: [entry, "competition/right/defender.bp"],
        locale,
        projectName: "Controller assignments",
        onSceneChange: vi.fn(),
        onSave: save,
        onPrepare: prepare,
        onClose: vi.fn(),
      };
      const source = (id: string) => h.button(`robot-${id}`).querySelector(".sim-robot-source")!;
      const status = (id: string) =>
        h.button(`robot-${id}`).querySelector(".sim-robot-name small")!;
      try {
        await act(async () =>
          h.root.render(createElement(SimulatorWorkspace, { ...props, scene })),
        );
        expect(source("A1").textContent).toBe("Main_Simple_L_2026.bp");
        expect(source("A1").getAttribute("title")).toBe(`${program} · ${entry}`);
        expect(source("A1").getAttribute("aria-label")).toContain(entry);
        expect(source("A2").textContent).toBe(`${builtin} · ${easy}`);
        expect(source("B1").textContent).toBe(`${builtin} · ${standard}`);
        expect(source("B2").textContent).toBe(`${builtin} · ${hard}`);
        expect(status("A1").textContent).toBe(ready);
        await act(async () => h.button("save").click());
        const restored = validateScene(JSON.parse(JSON.stringify(save.mock.calls[0]![0])));
        await act(async () =>
          h.root.render(createElement(SimulatorWorkspace, { ...props, scene: restored })),
        );
        await act(async () => h.button("start").click());
        const worker = UiWorker.instances[0]!;
        const load = worker.commands.find((command) => command.type === "load")!;
        expect(load.scene.robots.map((robot) => robot.controller)).toEqual(
          restored.robots.map((robot) => robot.controller),
        );
        await act(async () => {
          worker.snapshot = {
            ...worker.snapshot,
            robots: worker.snapshot.robots.map((robot) => ({
              ...robot,
              status: robot.id === "A1" ? "running" : "builtin",
            })),
          };
          worker.onmessage?.({
            data: { type: "snapshot", snapshot: worker.snapshot },
          } as MessageEvent<SimulationResponse>);
        });
        expect(status("A1").textContent).toBe(running);
        expect(status("A2").textContent).toBe(running);
        expect(source("A1").textContent).toBe("Main_Simple_L_2026.bp");
        expect(source("A2").textContent).toBe(`${builtin} · ${easy}`);

        // Replacing the saved scene abandons its worker before showing another assignment.
        const changed = structuredClone(restored);
        changed.robots[0]!.controller = { kind: "builtin", level: "hard" };
        changed.robots[1]!.controller = { kind: "disabled" };
        changed.robots[2]!.controller = { kind: "program", entry: "competition/right/defender.bp" };
        await act(async () =>
          h.root.render(createElement(SimulatorWorkspace, { ...props, scene: changed })),
        );
        expect(worker.terminated).toBe(true);
        expect(source("A1").textContent).toBe(`${builtin} · ${hard}`);
        expect(source("A2").textContent).toBe(disabled);
        expect(source("B1").textContent).toBe("defender.bp");
        expect(status("A1").textContent).toBe(ready);
        expect(status("A2").textContent).toBe(disabled);
        expect(h.element.querySelector(".sim-robots")?.textContent).not.toContain("Main_Simple");
        await act(async () => h.button("start").click());
        const nextLoad = UiWorker.instances[1]!.commands.find(
          (command) => command.type === "load",
        )!;
        expect(nextLoad.scene.robots.map((robot) => robot.controller)).toEqual(
          changed.robots.map((robot) => robot.controller),
        );
      } finally {
        await act(async () => h.root.unmount());
        h.element.remove();
      }
    },
  );

  it.each([
    [
      "en",
      "Wheel collision behavior",
      "Spin when blocked",
      "Stop when blocked (approximate)",
      "Gyro",
      "Reverse direction",
    ],
    ["zh-TW", "輪胎碰撞行為", "碰撞時空轉", "碰撞時輪子停轉（近似）", "陀螺儀", "反轉方向"],
  ] as const)(
    "saves and reopens wheel traction and gyro direction in %s",
    async (locale, tractionLabel, slipLabel, gripLabel, gyroLabel, reverseLabel) => {
      const h = setup(),
        save = vi.fn();
      let scene = createDefaultScene("main.bp");
      function Harness({ initialScene }: { initialScene: SimulationScene }) {
        const [value, setValue] = useState(initialScene);
        return createElement(SimulatorWorkspace, {
          scene: value,
          entries: ["main.bp"],
          locale,
          projectName: "Robot calibration",
          onSceneChange: (next) => {
            scene = next;
            setValue(next);
          },
          onSave: save,
          onPrepare: async () => ({ programs: {} }),
          onClose: vi.fn(),
        });
      }
      const traction = () =>
        [...h.element.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.getAttribute("aria-label") === tractionLabel,
        )!;
      const gyroReverse = () => {
        const card = [...h.element.querySelectorAll<HTMLFieldSetElement>(".sim-config-card")].find(
          (card) => card.querySelector("legend")?.textContent?.includes(gyroLabel),
        )!;
        const label = [...card.querySelectorAll<HTMLLabelElement>("label")].find(
          (label) => label.textContent === reverseLabel,
        )!;
        return label.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      };
      try {
        await act(async () => h.root.render(createElement(Harness, { initialScene: scene })));
        expect(traction().textContent).toContain(slipLabel);
        expect(gyroReverse().checked).toBe(false);
        await act(async () => traction().click());
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (option) => option.getAttribute("aria-label") === gripLabel,
        )!;
        await act(async () => option.click());
        await act(async () => gyroReverse().click());
        await act(async () => h.button("save").click());
        expect(save).toHaveBeenCalledOnce();
        const restored = validateScene(JSON.parse(JSON.stringify(scene)));
        expect(restored.robots[0]!.wheelTraction).toBe("grip");
        expect(restored.robots[0]!.sensors.find((sensor) => sensor.kind === "gyro")!.inverted).toBe(
          true,
        );
        expect(
          restored.robots[0]!.sensors.filter((sensor) => sensor.kind !== "gyro").every(
            (sensor) => sensor.inverted === undefined,
          ),
        ).toBe(true);
        await act(async () =>
          h.root.render(createElement(Harness, { key: "reopened", initialScene: restored })),
        );
        expect(traction().textContent).toContain(gripLabel);
        expect(gyroReverse().checked).toBe(true);
        expect(h.element.querySelector('[role="alert"]')).toBeNull();
      } finally {
        await act(async () => h.root.unmount());
        h.element.remove();
      }
    },
  );

  it("configures and saves Pixy2 camera geometry and signature filters through shared controls", async () => {
    const h = setup(),
      save = vi.fn();
    let scene = createDefaultScene("main.bp");
    function Harness() {
      const [value, setValue] = useState(scene);
      return createElement(SimulatorWorkspace, {
        scene: value,
        entries: ["main.bp"],
        locale: "en",
        projectName: "Camera setup",
        onSceneChange: (next) => {
          scene = next;
          setValue(next);
        },
        onSave: save,
        onPrepare: async () => ({ programs: {} }),
        onClose: vi.fn(),
      });
    }
    const choose = async (trigger: HTMLButtonElement, label: string) => {
      await act(async () => trigger.click());
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.getAttribute("aria-label") === label,
      )!;
      expect(option).toBeDefined();
      await act(async () => option.click());
    };
    try {
      await act(async () => h.root.render(createElement(Harness)));
      const types = h.element.querySelectorAll<HTMLButtonElement>('[aria-label="Kind"]');
      await choose(types[3]!, "Pixy2 camera (LEGO)");
      const camera = () => scene.robots[0]!.sensors[3]!;
      expect(camera()).toMatchObject({ kind: "pixy2", fov: 60, range: 2500 });
      expect(h.element.textContent).toContain("LEGO I2C color blocks only");
      const height = h.element.querySelector<HTMLInputElement>(
        '[aria-label="Camera height (mm)"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          height,
          "180",
        );
        height.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await choose(h.element.querySelector('[aria-label="Orange signature"]')!, "7");
      await choose(h.element.querySelector('[aria-label="Purple signature"]')!, "Not trained");
      expect(camera().pixy2).toEqual({
        height: 180,
        pitch: -10,
        verticalFov: 40,
        orangeSignature: 7,
        purpleSignature: 0,
      });
      await act(async () => h.button("save").click());
      expect(save).toHaveBeenCalledOnce();
      const persisted = validateScene(JSON.parse(JSON.stringify(scene)));
      expect(persisted.robots[0]!.sensors[3]).toEqual(camera());
      expect(h.element.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it.each([
    ["en", "Collision hints", "Restricted zones"],
    ["zh-TW", "碰撞提示", "限制區域"],
  ] as const)(
    "toggles visual guidance independently without changing the scene in %s",
    async (locale, collisionLabel, zoneLabel) => {
      const h = setup(),
        change = vi.fn(),
        prepare = vi.fn(async () => ({ programs: {} }));
      try {
        await act(async () =>
          h.root.render(
            createElement(SimulatorWorkspace, {
              scene: createDefaultScene("main.bp"),
              entries: ["main.bp"],
              locale,
              projectName: "Overlays",
              onSceneChange: change,
              onSave: vi.fn(),
              onPrepare: prepare,
              onClose: vi.fn(),
            }),
          ),
        );
        const trigger = h.element.querySelector<HTMLButtonElement>(".sim-layers .picker-trigger")!;
        await act(async () => trigger.click());
        const list = document.querySelector('[role="listbox"]')!;
        expect(list.getAttribute("aria-multiselectable")).toBe("true");
        const option = (label: string) =>
          [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
            (element) => element.getAttribute("aria-label") === label,
          )!;
        const collisions = option(collisionLabel),
          zones = option(zoneLabel);
        expect(collisions.getAttribute("aria-selected")).toBe("true");
        expect(zones.getAttribute("aria-selected")).toBe("true");
        await act(async () => collisions.click());
        expect(collisions.getAttribute("aria-selected")).toBe("false");
        expect(zones.getAttribute("aria-selected")).toBe("true");
        await act(async () => zones.click());
        await act(async () => collisions.click());
        expect(collisions.getAttribute("aria-selected")).toBe("true");
        expect(zones.getAttribute("aria-selected")).toBe("false");
        await act(async () =>
          collisions.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
        );
        expect(document.querySelector('[role="listbox"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
        expect(change).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        await act(async () => h.root.unmount());
        h.element.remove();
      }
    },
  );

  it("surfaces another robot's latest runtime error and opens its source while selecting that robot", async () => {
    const h = setup(),
      source = vi.fn();
    const scene = createDefaultScene("main.bp"),
      defender = scene.robots.find((robot) => robot.id === "B1")!;
    defender.name = "Defender";
    defender.controller = { kind: "program", entry: "src/defender.bp" };
    const errorSpan = {
      file: "src/defender.bp",
      start: { line: 7, column: 3, offset: 70 },
      end: { line: 7, column: 20, offset: 87 },
    };
    try {
      await act(async () =>
        h.root.render(
          createElement(SimulatorWorkspace, {
            scene,
            entries: ["main.bp", "src/defender.bp"],
            locale: "en",
            projectName: "Runtime errors",
            onSceneChange: vi.fn(),
            onSave: vi.fn(),
            onPrepare: async () => ({ programs: {} }),
            onClose: vi.fn(),
            onSource: source,
          }),
        ),
      );
      await act(async () => h.button("start").click());
      const selection = () =>
        h.element.querySelector('.sim-robots [aria-pressed="true"]')?.getAttribute("data-testid");
      expect(selection()).toBe("simulator-robot-A1");
      const worker = UiWorker.instances[0]!;
      worker.snapshot = {
        ...worker.snapshot,
        status: "error",
        selectedRobotId: "A1",
        events: [
          { id: 1, timeMs: 0, kind: "error", message: "Previous failure", robotId: "A2" },
          {
            id: 2,
            timeMs: 10,
            kind: "error",
            message: "Division by zero",
            robotId: "B1",
            span: errorSpan,
          },
        ],
        // The currently selected A1 is healthy, so its inspector cannot supply B1's error.
        debug: {
          status: "paused",
          device: new VirtualDevice().snapshot(),
          globals: {},
          locals: {},
          callStack: [],
          instructions: 1,
          elapsedMs: 10,
          threadCount: 1,
        },
      };
      await act(async () =>
        worker.onmessage?.(
          new MessageEvent<SimulationResponse>("message", {
            data: { type: "snapshot", snapshot: worker.snapshot },
          }),
        ),
      );
      const alert = h.element.querySelector<HTMLElement>('[role="alert"]')!;
      expect(alert.textContent).toContain("B1 · Defender");
      expect(alert.textContent).toContain("Division by zero");
      expect(alert.textContent).not.toContain("Previous failure");
      expect(alert.textContent).toContain("src/defender.bp:7:3");
      expect(selection()).toBe("simulator-robot-A1");
      await act(async () => alert.querySelector<HTMLButtonElement>("button")!.click());
      expect(source).toHaveBeenCalledExactlyOnceWith(errorSpan);
      expect(selection()).toBe("simulator-robot-B1");
      expect(worker.commands).toContainEqual({ type: "select", robotId: "B1" });
      expect(h.element.querySelector("#sim-tab-inspect")?.getAttribute("aria-selected")).toBe(
        "true",
      );
      await act(async () => h.button("reset").click());
      expect(h.element.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it.each(["en", "zh-TW"] as const)(
    "prepares, runs, pauses, steps, resets and terminates in %s",
    async (locale) => {
      const h = setup(),
        prepare = vi.fn(async () => ({ programs: {} })),
        close = vi.fn();
      const scene = createDefaultScene("main.bp");
      try {
        await act(async () =>
          h.root.render(
            createElement(SimulatorWorkspace, {
              scene,
              entries: ["main.bp"],
              locale,
              projectName: "Demo",
              onSceneChange: vi.fn(),
              onSave: vi.fn(),
              onPrepare: prepare,
              onClose: close,
            }),
          ),
        );
        expect(h.element.querySelector('[role="dialog"]')).toBeNull();
        expect(h.element.querySelector('[data-testid="simulator-field"]')).not.toBeNull();
        await act(async () => h.button("start").click());
        expect(prepare).toHaveBeenCalledOnce();
        expect(
          h.element.querySelector('[data-testid="simulator-status"]')?.getAttribute("data-state"),
        ).toBe("running");
        expect(h.button("step").disabled).toBe(true);
        await act(async () => h.button("start").click());
        await act(async () => h.button("step").click());
        expect(
          h.element.querySelector('[data-testid="simulator-status"]')?.getAttribute("data-time-ms"),
        ).toBe("10");
        await act(async () => h.button("reset").click());
        expect(
          h.element.querySelector('[data-testid="simulator-status"]')?.getAttribute("data-state"),
        ).toBe("ready");
        await act(async () => h.button("close").click());
        expect(close).toHaveBeenCalledOnce();
      } finally {
        await act(async () => h.root.unmount());
        h.element.remove();
      }
      expect(UiWorker.instances[0]?.terminated).toBe(true);
    },
  );

  it("starts after StrictMode replays effects and still terminates its worker on unmount", async () => {
    const h = setup(),
      prepare = vi.fn(async () => ({ programs: {} }));
    try {
      await act(async () =>
        h.root.render(
          createElement(
            StrictMode,
            null,
            createElement(SimulatorWorkspace, {
              scene: createDefaultScene("main.bp"),
              entries: ["main.bp"],
              locale: "en",
              projectName: "Strict",
              onSceneChange: vi.fn(),
              onSave: vi.fn(),
              onPrepare: prepare,
              onClose: vi.fn(),
            }),
          ),
        ),
      );
      await act(async () => h.button("start").click());
      expect(prepare).toHaveBeenCalledOnce();
      expect(
        h.element.querySelector('[data-testid="simulator-status"]')?.getAttribute("data-state"),
      ).toBe("running");
      expect(UiWorker.instances).toHaveLength(1);
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
    expect(UiWorker.instances[0]?.terminated).toBe(true);
  });

  it("promotes match opponents, edits drive presets, clears conflicting shooter and randomizes reproducibly", async () => {
    const h = setup();
    let scene: SimulationScene = createDefaultScene("main.bp");
    function Harness() {
      const [value, setValue] = useState(scene);
      return createElement(SimulatorWorkspace, {
        scene: value,
        entries: ["main.bp"],
        locale: "en",
        projectName: "Demo",
        onSceneChange: (next) => {
          scene = next;
          setValue(next);
        },
        onSave: vi.fn(),
        onPrepare: async () => ({ programs: {} }),
        onClose: vi.fn(),
      });
    }
    try {
      await act(async () => h.root.render(createElement(Harness)));
      const setupTab = h.element.querySelector<HTMLButtonElement>("#sim-tab-setup")!;
      await act(async () => {
        setupTab.focus();
        setupTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      });
      expect(document.activeElement?.id).toBe("sim-tab-scene");
      expect(h.element.querySelectorAll('.sim-tabs [role="tab"][tabindex="0"]')).toHaveLength(1);
      await act(async () =>
        [...h.element.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
          .find((radio) => radio.textContent === "Match")!
          .click(),
      );
      expect(scene.robots.filter((robot) => robot.controller.kind === "builtin")).toHaveLength(3);
      await act(async () => h.element.querySelector<HTMLButtonElement>("#sim-tab-setup")!.click());
      const drive = h.element.querySelector<HTMLButtonElement>(
        '.picker-trigger[aria-label="Drive"]',
      )!;
      await act(async () => drive.click());
      await act(async () =>
        document.querySelector<HTMLElement>('[data-picker-value="omni4"]')!.click(),
      );
      expect(scene.robots[0]?.wheels).toHaveLength(4);
      expect(scene.robots[0]?.shooter).toBeNull();
      await act(async () => h.element.querySelector<HTMLButtonElement>("#sim-tab-scene")!.click());
      const previousSeed = scene.seed;
      const button = [...h.element.querySelectorAll("button")].find(
        (button) => button.textContent === "New seed & balls",
      )!;
      await act(async () => button.click());
      expect(scene.seed).toBe(previousSeed + 1);
      const balls = structuredClone(scene.balls);
      await act(async () =>
        [...h.element.querySelectorAll("button")]
          .find((button) => button.textContent === "Apply seed")!
          .click(),
      );
      expect(scene.balls).toEqual(balls);
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("pauses a retained workspace when hidden and releases virtual buttons", async () => {
    const h = setup();
    const props = {
      scene: createDefaultScene("main.bp"),
      entries: ["main.bp"],
      locale: "en" as const,
      projectName: "Demo",
      onSceneChange: vi.fn(),
      onSave: vi.fn(),
      onPrepare: async () => ({ programs: {} }),
      onClose: vi.fn(),
    };
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      await act(async () => h.button("start").click());
      const enter = h.element.querySelector<HTMLButtonElement>('[data-sim-button="enter"]')!;
      await act(async () =>
        enter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(UiWorker.instances[0]!.commands.at(-1)).toMatchObject({
        type: "buttons",
        buttons: ["enter"],
      });
      await act(async () =>
        h.root.render(createElement(SimulatorWorkspace, { ...props, active: false })),
      );
      expect(UiWorker.instances[0]!.commands).toContainEqual({ type: "pause" });
      expect(UiWorker.instances[0]!.commands.at(-1)).toMatchObject({
        type: "buttons",
        buttons: [],
      });
      expect(h.element.querySelector("section")?.hidden).toBe(true);
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("keeps an invalid-scene workspace visible but pauses and blocks execution and editing", async () => {
    const h = setup(),
      prepare = vi.fn(async () => ({ programs: {} })),
      change = vi.fn();
    const props = {
      scene: createDefaultScene("main.bp"),
      entries: ["main.bp"],
      locale: "en" as const,
      projectName: "Demo",
      onSceneChange: change,
      onSave: vi.fn(),
      onPrepare: prepare,
      onClose: vi.fn(),
    };
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      await act(async () => h.button("start").click());
      await act(async () =>
        h.root.render(createElement(SimulatorWorkspace, { ...props, blocked: true })),
      );
      expect(h.element.querySelector("section")?.hidden).toBe(false);
      expect(UiWorker.instances[0]!.commands).toContainEqual({ type: "pause" });
      for (const name of ["start", "step", "reset"]) {
        expect(h.button(name).disabled).toBe(true);
        await act(async () => h.button(name).click());
      }
      await act(async () => h.element.querySelector<HTMLButtonElement>("#sim-tab-scene")!.click());
      const match = [...h.element.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (radio) => radio.textContent === "Match",
      )!;
      expect(match.disabled).toBe(true);
      await act(async () => match.click());
      expect(change).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
      expect(
        UiWorker.instances[0]!.commands.filter((command) => command.type === "run"),
      ).toHaveLength(1);
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("forwards a pending preparation cancellation once when blocked and then unmounted", async () => {
    const h = setup(),
      cancel = vi.fn();
    let resolve!: (value: PreparedSimulation) => void;
    const preparation = new Promise<PreparedSimulation>((done) => {
      resolve = done;
    });
    const props = {
      scene: createDefaultScene("main.bp"),
      entries: ["main.bp"],
      locale: "en" as const,
      projectName: "Demo",
      onSceneChange: vi.fn(),
      onSave: vi.fn(),
      onPrepare: () => preparation,
      onCancelPrepare: cancel,
      onClose: vi.fn(),
    };
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      await act(async () => h.button("start").click());
      await act(async () =>
        h.root.render(createElement(SimulatorWorkspace, { ...props, blocked: true })),
      );
      expect(cancel).toHaveBeenCalledOnce();
      await act(async () => {
        resolve({ programs: {} });
        await preparation;
      });
      expect(UiWorker.instances).toHaveLength(0);
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("clears the previous LCD frame when a replacement compilation fails", async () => {
    const h = setup(),
      prepare = vi
        .fn()
        .mockResolvedValueOnce({ programs: {} })
        .mockRejectedValue(new Error("Compile failed"));
    const props = {
      scene: createDefaultScene("main.bp"),
      entries: ["main.bp"],
      locale: "en" as const,
      projectName: "Demo",
      sourceRevision: "r1",
      onSceneChange: vi.fn(),
      onSave: vi.fn(),
      onPrepare: prepare,
      onClose: vi.fn(),
    };
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      await act(async () => h.button("start").click());
      const worker = UiWorker.instances[0]!,
        device = new VirtualDevice().snapshot();
      device.lcd.pixels[0] = 1;
      await act(async () =>
        worker.onmessage?.(
          new MessageEvent<SimulationResponse>("message", {
            data: {
              type: "snapshot",
              snapshot: {
                ...worker.snapshot,
                debug: {
                  status: "running",
                  device,
                  globals: {},
                  locals: {},
                  callStack: [],
                  instructions: 1,
                  elapsedMs: 10,
                  threadCount: 1,
                },
              },
            },
          }),
        ),
      );
      expect(h.paintCanvas).toHaveBeenCalled();
      h.clearCanvas.mockClear();
      // Pause, edit the program, and Start again: the changed sources are rebuilt.
      await act(async () => h.button("start").click());
      await act(async () =>
        h.root.render(createElement(SimulatorWorkspace, { ...props, sourceRevision: "r2" })),
      );
      await act(async () => h.button("start").click());
      expect(h.element.querySelector('[role="alert"]')?.textContent).toContain("Compile failed");
      expect(h.clearCanvas).toHaveBeenCalledWith(0, 0, 178, 128);
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("keeps invalid form drafts editable while Save and Start diagnose them", async () => {
    const h = setup(),
      save = vi.fn(),
      prepare = vi.fn(async () => ({ programs: {} }));
    let scene = createDefaultScene("main.bp");
    function Harness() {
      const [value, setValue] = useState(scene);
      return createElement(SimulatorWorkspace, {
        scene: value,
        entries: ["main.bp"],
        locale: "en",
        projectName: "Demo",
        onSceneChange: (next) => {
          scene = next;
          setValue(next);
        },
        onSave: save,
        onPrepare: prepare,
        onClose: vi.fn(),
      });
    }
    const setName = async (value: string) => {
      const input = h.element.querySelector<HTMLInputElement>(
        '.sim-robot-settings input[maxlength="32"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    try {
      await act(async () => h.root.render(createElement(Harness)));
      await setName("");
      expect(scene.robots[0]!.name).toBe("");
      await act(async () => h.button("save").click());
      expect(save).not.toHaveBeenCalled();
      expect(h.element.textContent).toContain("Could not save scene");
      await act(async () => h.button("start").click());
      expect(prepare).not.toHaveBeenCalled();
      expect(h.element.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () =>
        [...h.element.querySelectorAll("button")]
          .find((button) => button.textContent === "Robot setup")!
          .click(),
      );
      expect(h.element.querySelector(".sim-robot-settings")?.hasAttribute("disabled")).toBe(false);
      await setName("Tester");
      await act(async () => h.button("start").click());
      expect(prepare).toHaveBeenCalledOnce();
      expect(
        h.element.querySelector('[data-testid="simulator-status"]')?.getAttribute("data-state"),
      ).toBe("running");
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("maps pan and zoom back to exact millimetre coordinates", () => {
    const camera = { zoom: 2.5, panX: 42, panY: -17 },
      transform = fieldTransform(800, 400, camera);
    const point = fieldPoint(
      transform.x + FIELD.midX * transform.scale,
      transform.y - 120 * transform.scale,
      800,
      400,
      camera,
    );
    expect(point.x).toBeCloseTo(FIELD.midX);
    expect(point.y).toBeCloseTo(120);
  });

  const baseProps = (scene: SimulationScene) => ({
    scene,
    entries: ["main.bp"],
    locale: "en" as const,
    projectName: "Demo",
    onSceneChange: vi.fn(),
    onSave: vi.fn(),
    onPrepare: vi.fn(async (): Promise<PreparedSimulation> => ({ programs: {} })),
    onClose: vi.fn(),
  });
  const status = (h: ReturnType<typeof setup>) =>
    h.element.querySelector('[data-testid="simulator-status"]')?.getAttribute("data-state");

  it("resumes an unchanged program and rebuilds on Start after the sources change", async () => {
    const h = setup(),
      props = { ...baseProps(createDefaultScene("main.bp")), sourceRevision: "a" };
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      await act(async () => h.button("start").click());
      await act(async () => h.button("start").click());
      expect(status(h)).toBe("paused");
      await act(async () => h.button("start").click());
      expect(props.onPrepare).toHaveBeenCalledOnce();
      expect(status(h)).toBe("running");
      await act(async () => h.button("start").click());
      await act(async () =>
        h.root.render(createElement(SimulatorWorkspace, { ...props, sourceRevision: "b" })),
      );
      expect(h.element.querySelector(".sim-stale")?.textContent).toContain("Program changed");
      await act(async () => h.button("start").click());
      expect(props.onPrepare).toHaveBeenCalledTimes(2);
      expect(UiWorker.instances[0]!.terminated).toBe(true);
      expect(UiWorker.instances[1]!.commands.at(-1)).toEqual({ type: "run" });
      expect(h.element.querySelector(".sim-stale")).toBeNull();
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("keeps setup editable while running and resets the run with a notice", async () => {
    const h = setup(),
      props = baseProps(createDefaultScene("main.bp"));
    function Harness() {
      const [scene, setScene] = useState(props.scene);
      return createElement(SimulatorWorkspace, {
        ...props,
        scene,
        onSceneChange: (next: SimulationScene) => {
          props.onSceneChange(next);
          setScene(next);
        },
      });
    }
    try {
      await act(async () => h.root.render(createElement(Harness)));
      await act(async () => h.button("start").click());
      expect(status(h)).toBe("running");
      await act(async () => h.element.querySelector<HTMLButtonElement>("#sim-tab-scene")!.click());
      const match = [...h.element.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (radio) => radio.textContent === "Match",
      )!;
      expect(match.disabled).toBe(false);
      await act(async () => match.click());
      expect(props.onSceneChange).toHaveBeenCalledOnce();
      expect(UiWorker.instances[0]!.terminated).toBe(true);
      expect(status(h)).toBe("ready");
      expect(h.element.querySelector(".sim-save-message")?.textContent).toBe(
        "Scene reset to apply the new setup.",
      );
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("warns about ports the robot lacks and opens that robot's setup", async () => {
    const h = setup(),
      props = baseProps(createPracticeScene("main.bp"));
    const ir: KobrixaIR = {
      version: 1,
      program: { name: "main", entryFunction: "main" },
      globals: [],
      functions: [
        {
          name: "main",
          parameters: [],
          returnType: { kind: "void" },
          locals: [],
          entryBlock: "entry",
          blocks: [
            {
              id: "entry",
              instructions: [
                {
                  op: "ev3-call",
                  operation: "Motor.Start",
                  args: [
                    { kind: "string", value: "A" },
                    { kind: "integer", value: 50 },
                  ],
                } as IRInstruction,
              ],
              terminator: { op: "stop" },
            },
          ],
        },
      ],
      resources: [],
      sourceFiles: ["main.bp"],
    };
    props.onPrepare.mockResolvedValue({ programs: { "main.bp": { ir, files: {} } } });
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      await act(async () => h.button("start").click());
      // A warning never blocks the run.
      expect(status(h)).toBe("running");
      const banner = h.element.querySelector(".sim-warning")!;
      expect(banner.getAttribute("role")).toBe("status");
      expect(banner.textContent).toContain("The program uses ports this robot does not have");
      expect(banner.querySelector("li")?.textContent).toBe(
        "A1: Motor A is used, but no wheel or shooter is on A.",
      );
      expect(h.element.querySelector("#sim-tab-inspect")?.getAttribute("aria-selected")).toBe(
        "true",
      );
      await act(async () => h.button("open-setup").click());
      expect(h.element.querySelector("#sim-tab-setup")?.getAttribute("aria-selected")).toBe("true");
      await act(async () => h.button("reset").click());
      expect(h.element.querySelector(".sim-warning")).toBeNull();
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it("shows only elapsed time and robot setup on the practice field", async () => {
    const h = setup(),
      props = baseProps(createPracticeScene("main.bp"));
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      expect(h.element.querySelector("#sim-tab-scene")).toBeNull();
      expect(h.element.querySelector("#sim-tab-setup")).not.toBeNull();
      expect(h.element.querySelector(".sim-score")).toBeNull();
      expect(h.element.querySelector('[role="progressbar"]')).toBeNull();
      expect(h.element.querySelector('[role="timer"]')?.getAttribute("aria-label")).toBe(
        "Elapsed time",
      );
      expect(h.element.querySelector(".sim-robot-header")?.textContent).not.toContain("Add robot");
      expect(h.element.querySelector(".sim-field-hint")).not.toBeNull();
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });

  it.each([true, false])("switches field (scene dirty: %s)", async (sceneDirty) => {
    const h = setup(),
      scene = { ...createDefaultScene("main.bp"), seed: 7 },
      props = { ...baseProps(scene), sceneDirty };
    try {
      await act(async () => h.root.render(createElement(SimulatorWorkspace, props)));
      await act(async () =>
        h.element
          .querySelector<HTMLButtonElement>('[data-testid="simulator-field-select"] button')!
          .click(),
      );
      await act(async () =>
        document.querySelector<HTMLElement>('[data-picker-value="practice"]')!.click(),
      );
      const dialog = document.querySelector(".simulator-field-confirm");
      if (sceneDirty) {
        expect(dialog?.getAttribute("role")).toBe("alertdialog");
        expect(props.onSceneChange).not.toHaveBeenCalled();
        const cancel = [...dialog!.querySelectorAll("button")].find(
          (button) => button.textContent === "Cancel",
        )!;
        await act(async () => cancel.click());
        expect(document.querySelector(".simulator-field-confirm")).toBeNull();
        expect(props.onSceneChange).not.toHaveBeenCalled();
      } else {
        expect(dialog).toBeNull();
        expect(props.onSceneChange).toHaveBeenCalledOnce();
        expect(props.onSceneChange.mock.calls[0]![0]).toEqual(createPracticeScene("main.bp"));
      }
    } finally {
      await act(async () => h.root.unmount());
      h.element.remove();
    }
  });
});
