// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MotorTestRequest, MotorTestState } from "../../shared/motor-test.js";
import { Segmented } from "../components/segmented.js";
import { MotorTestController } from "./motor-test-controller.js";
import { MotorTestControls, motorFieldErrors, motorTestProgress } from "./motor-test-controls.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});
function render(element: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}
const idle: MotorTestState = { phase: "idle", angle: null, displacement: null, elapsedMs: 0 };
const request = (patch: Partial<MotorTestRequest> = {}): MotorTestRequest => ({
  sessionId: "s",
  testId: "t",
  port: 0,
  power: 20,
  direction: 1,
  mode: "timed",
  brake: true,
  durationMs: 1_000,
  ...patch,
});
function controls(state: MotorTestState, props: { canStart: boolean; blockedReason?: string }) {
  const controller = new MotorTestController({} as never);
  const start = vi.spyOn(controller, "start").mockResolvedValue();
  const stop = vi.spyOn(controller, "stop").mockResolvedValue(idle);
  return { controller, start, stop, props: { state, port: 0, locale: "en" as const, ...props } };
}

describe("motor test field validation", () => {
  it("only validates fields the selected movement uses and keeps blanks quiet", () => {
    expect(motorFieldErrors("jog", "20", "", "abc")).toEqual({
      power: undefined,
      seconds: undefined,
      degrees: undefined,
    });
    expect(motorFieldErrors("timed", "", "9", "1")).toMatchObject({
      power: "empty",
      seconds: "range",
    });
    expect(motorFieldErrors("angle", "1.5", "1", "3600")).toMatchObject({
      power: "range",
      degrees: undefined,
    });
  });
  it("reports progress toward each movement's end condition", () => {
    expect(motorTestProgress(idle)).toBeUndefined();
    expect(motorTestProgress({ ...idle, request: request(), elapsedMs: 250 })).toBe(0.25);
    expect(
      motorTestProgress({
        ...idle,
        request: request({ mode: "angle", degrees: 90 }),
        displacement: -45,
      }),
    ).toBe(0.5);
    expect(
      motorTestProgress({ ...idle, request: request({ mode: "jog" }), elapsedMs: 20_000 }),
    ).toBe(1);
  });
});

describe("Segmented", () => {
  it("moves and selects with arrow keys as one tab stop", () => {
    const onChange = vi.fn();
    const view = render(
      createElement(Segmented<string>, {
        value: "b",
        onChange,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
        ],
      }),
    );
    const radios = Array.from(view.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    act(() =>
      radios[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(onChange).toHaveBeenLastCalledWith("c");
    act(() =>
      radios[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );
    expect(onChange).toHaveBeenLastCalledWith("c");
    act(() =>
      radios[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    );
    expect(onChange).toHaveBeenLastCalledWith("a");
  });
});

describe("MotorTestControls", () => {
  it("jogs in the direction of the held button without changing the saved direction", () => {
    const { controller, start, props } = controls(idle, { canStart: true });
    const view = render(createElement(MotorTestControls, { controller, ...props }));
    const reverse = view.querySelector<HTMLButtonElement>(
      '[data-testid="motor-test-jog-reverse"]',
    )!;
    act(() => reverse.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: "jog", direction: -1 }));
    expect(controller.getSettings(0).direction).toBe(1);
  });
  it("explains why a test cannot start", () => {
    const { controller, props } = controls(idle, {
      canStart: false,
      blockedReason: "Stop the EV3 user program to test motors.",
    });
    const view = render(createElement(MotorTestControls, { controller, ...props }));
    expect(view.querySelector(".motor-test-blocked")?.textContent).toBe(
      "Stop the EV3 user program to test motors.",
    );
  });
  it("turns the start action into stop while its own test runs", () => {
    const running: MotorTestState = {
      ...idle,
      request: request(),
      phase: "running",
      elapsedMs: 500,
    };
    const { controller, stop, props } = controls(running, { canStart: true });
    controller.saveSettings(0, {
      power: "20",
      seconds: "1",
      degrees: "90",
      direction: 1,
      brake: true,
      mode: "timed",
    });
    const view = render(createElement(MotorTestControls, { controller, ...props }));
    expect(view.querySelector('[data-testid="motor-test-start"]')).toBeNull();
    const action = view.querySelector<HTMLButtonElement>('[data-testid="motor-test-stop"]')!;
    expect(action.disabled).toBe(false);
    expect(view.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
    act(() => action.click());
    expect(stop).toHaveBeenCalled();
  });
});
