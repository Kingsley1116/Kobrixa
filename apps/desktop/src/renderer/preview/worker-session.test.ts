import { afterEach, describe, expect, it, vi } from "vitest";
import type { KobrixaIR } from "@kobrixa/ir";
import type { PreviewSnapshot } from "../../preview/runtime.js";
import { PreviewWorkerSession } from "./worker-session.js";

export const endlessProgram: KobrixaIR = {
  version: 1,
  program: { name: "Preview", entryFunction: "main" },
  globals: [{ name: "count", type: { kind: "integer" }, scope: "global" }],
  functions: [
    {
      name: "main",
      parameters: [],
      locals: [],
      returnType: { kind: "void" },
      entryBlock: "loop",
      blocks: [
        {
          id: "loop",
          instructions: [
            {
              op: "binary",
              target: "count",
              operator: "+",
              left: { kind: "variable", name: "count" },
              right: { kind: "integer", value: 1 },
            },
          ],
          terminator: { op: "jump", target: "loop" },
        },
      ],
    },
  ],
  resources: [],
  sourceFiles: ["main.bas"],
};

afterEach(() => vi.useRealTimers());

describe("preview worker session", () => {
  it("yields bounded slices for an endless program, pauses, steps and disposes", () => {
    vi.useFakeTimers();
    let latest: PreviewSnapshot | undefined;
    const session = new PreviewWorkerSession((message) => {
      if (message.type === "snapshot") latest = message.snapshot;
      else throw new Error(message.message);
    });
    session.receive({ type: "load", ir: endlessProgram });
    expect(latest?.status).toBe("ready");
    session.receive({ type: "run" });
    vi.advanceTimersByTime(32);
    expect(latest?.status).toBe("running");
    expect(latest?.instructions).toBe(2000);
    expect(latest?.globals.count).toBe(1000);
    session.receive({ type: "pause" });
    vi.advanceTimersByTime(1000);
    expect(latest?.instructions).toBe(2000);
    expect(latest?.status).toBe("paused");
    session.receive({ type: "step" });
    expect(latest?.instructions).toBe(2001);
    expect(latest?.globals.count).toBe(1001);
    session.receive({ type: "run" });
    session.dispose();
    vi.advanceTimersByTime(5000);
    expect(latest?.instructions).toBe(2001);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies only supported speeds and resets virtual output while restoring selected inputs/assets", () => {
    vi.useFakeTimers();
    let latest: PreviewSnapshot | undefined;
    const session = new PreviewWorkerSession((message) => {
      if (message.type === "snapshot") latest = message.snapshot;
    });
    const inputs = { sensors: { 1: { type: 29, mode: 0, si: [42] } }, batteryLevel: 75 };
    session.receive({ type: "load", ir: endlessProgram, files: { "note.txt": [65, 66] }, inputs });
    session.receive({ type: "speed", value: 2 });
    session.receive({ type: "run" });
    vi.advanceTimersByTime(32);
    expect(latest?.elapsedMs).toBe(64);
    session.receive({ type: "speed", value: Infinity });
    vi.advanceTimersByTime(32);
    expect(latest?.elapsedMs).toBe(128);
    session.receive({ type: "inputs", inputs: { buttons: ["enter"] } });
    expect(latest?.device.buttons).toEqual(["enter"]);
    session.receive({ type: "stop" });
    expect(latest?.status).toBe("stopped");
    session.receive({ type: "load", ir: endlessProgram, files: { "note.txt": [65, 66] }, inputs });
    expect(latest?.globals.count).toBe(0);
    expect(latest?.elapsedMs).toBe(0);
    expect(latest?.device.sensors[1].si).toEqual([42]);
    expect(latest?.device.batteryLevel).toBe(75);
    expect(latest?.device.buttons).toEqual([]);
    expect(latest?.device.files).toEqual([
      { path: expect.stringMatching(/\/note\.txt$/), size: 2 },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    session.dispose();
  });
});
