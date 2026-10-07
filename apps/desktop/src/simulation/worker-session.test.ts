import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulationResponse } from "../shared/simulator.js";
import { createDefaultScene } from "./scene.js";
import { SimulationWorkerSession } from "./worker-session.js";

afterEach(() => vi.useRealTimers());
describe("simulation worker lifecycle", () => {
  it("paces fixed ticks, pauses without advancing, resets, and cancels timers on disposal", () => {
    vi.useFakeTimers();
    const responses: SimulationResponse[] = [];
    const session = new SimulationWorkerSession(
      (response) => responses.push(response),
      () => Date.now(),
    );
    const scene = createDefaultScene();
    scene.robots.forEach((robot) => {
      robot.controller = { kind: "disabled" };
    });
    session.receive({ type: "load", scene, prepared: { programs: {} } });
    session.receive({ type: "run" });
    vi.advanceTimersByTime(160);
    expect(responses.at(-1)).toMatchObject({
      type: "snapshot",
      snapshot: { timeMs: 160, status: "running" },
    });
    session.receive({ type: "pause" });
    vi.advanceTimersByTime(500);
    expect(responses.at(-1)).toMatchObject({
      type: "snapshot",
      snapshot: { timeMs: 160, status: "paused" },
    });
    session.receive({ type: "step" });
    expect(responses.at(-1)).toMatchObject({ type: "snapshot", snapshot: { timeMs: 170 } });
    session.receive({ type: "select", robotId: "B1" });
    session.receive({ type: "reset" });
    expect(responses.at(-1)).toMatchObject({
      type: "snapshot",
      snapshot: { timeMs: 0, status: "ready", selectedRobotId: "B1" },
    });
    session.receive({ type: "speed", value: 4 });
    session.receive({ type: "run" });
    vi.advanceTimersByTime(160);
    expect(responses.at(-1)).toMatchObject({ type: "snapshot", snapshot: { timeMs: 640 } });
    session.dispose();
    const count = responses.length;
    vi.advanceTimersByTime(1000);
    expect(responses).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports invalid configuration without starting a timer", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const session = new SimulationWorkerSession(emit);
    const scene = createDefaultScene();
    scene.robots[0]!.pose.x = NaN;
    session.receive({ type: "load", scene, prepared: { programs: {} } });
    expect(emit).toHaveBeenLastCalledWith({
      type: "error",
      message: expect.stringContaining("pose.x"),
    });
    expect(vi.getTimerCount()).toBe(0);
    session.dispose();
  });
});
