import { describe, expect, it } from "vitest";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import { validateIR } from "@kobrixa/ir";
// @ts-expect-error The existing bytecode regression VM is implemented in JavaScript.
import { decode, VM } from "../../../../tests/bytecode/support/ev3-vm.mjs";
import type { SensorCalibration, SensorChannel } from "./sensor-lab.js";
import {
  calibrate,
  calibrationCode,
  identityCalibration,
  validateCalibration,
} from "./sensor-calibration.js";

const source: SensorChannel = {
  id: "test",
  kind: "input",
  port: 1,
  type: 30,
  mode: 0,
  channel: 1,
  name: "Ultrasonic",
  modeName: "US-DIST-CM",
  unit: "cm",
  decimals: 1,
};
const twoPoint = (patch: Partial<SensorCalibration> = {}): SensorCalibration => ({
  ...identityCalibration("cm"),
  twoPoint: true,
  sourceA: 10,
  sourceB: 50,
  targetA: 0,
  targetB: 100,
  ...patch,
});

async function execute(code: string, scenario: Record<string, unknown>) {
  const front = await new BasicPlusFrontend().compile(
    {
      root: "/lab",
      manifest: {
        schemaVersion: 1,
        name: "calibration",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "build",
      },
      sources: [{ path: "main.bp", content: code }],
      assets: [],
    },
    new AbortController().signal,
  );
  expect(front.diagnostics).toEqual([]);
  expect(validateIR(front.ir!)).toEqual([]);
  const back = await new EV3Backend().compile(front.ir!, new AbortController().signal);
  expect(back.diagnostics).toEqual([]);
  const vm = new VM(decode(back.rbf!), scenario);
  const run = vm.run();
  expect(run.status, run.error).toBe("ended");
  return {
    vm,
    texts: run.trace
      .filter((entry: { op: string }) => entry.op === "UI_DRAW.TEXT")
      .map((entry: { args: unknown[] }) => String(entry.args[3])) as string[],
  };
}

describe("sensor calibration", () => {
  it("maps two points, reversed ranges, extrapolation and zero offsets without clamping", () => {
    expect(calibrate(5, twoPoint({ sourceA: 0, sourceB: 3 }))).toBe(166.6666717529297);
    expect(calibrate(10, twoPoint())).toBe(0);
    expect(calibrate(50, twoPoint())).toBe(100);
    expect(calibrate(70, twoPoint())).toBe(150);
    expect(calibrate(30, twoPoint({ sourceA: 50, sourceB: 10 }))).toBe(50);
    expect(calibrate(30, twoPoint({ zeroOffset: 12.5 }))).toBe(37.5);
    expect(calibrate(-12.25, { ...identityCalibration("deg"), zeroOffset: -2 })).toBe(-10.25);
    expect(calibrate(0, identityCalibration("cm"))).toBe(0);
  });
  it("validates float32 precision and preserves missing/overflow values", () => {
    expect(validateCalibration(twoPoint({ sourceA: 1, sourceB: 1 + 1e-10 }))).toBe("sameSource");
    expect(validateCalibration(twoPoint({ targetA: Infinity }))).toBe("nonFinite");
    expect(validateCalibration(twoPoint({ zeroOffset: 1e40 }))).toBe("float32Range");
    expect(validateCalibration(twoPoint({ targetA: 3e38, targetB: 3e38, zeroOffset: -3e38 }))).toBe(
      "float32Range",
    );
    expect(validateCalibration(twoPoint({ unit: "cm\n" }))).toBe("invalidUnit");
    expect(validateCalibration(twoPoint({ sourceB: 1e30, sourceA: -1e30, targetB: 1e-30 }))).toBe(
      "float32Range",
    );
    expect(calibrate(null, twoPoint())).toBeNull();
    expect(calibrate(NaN, twoPoint())).toBeNull();
    expect(calibrate(Infinity, twoPoint())).toBeNull();
    expect(calibrate(3e38, twoPoint())).toBeNull();
    expect(calibrationCode(source, identityCalibration('unit "quoted"'), "en")).toContain(
      'unit ""quoted""',
    );
  });
});

describe("generated calibration programs", () => {
  it.each(["en", "zh-TW"] as const)(
    "compiles and executes a nonzero SI channel in %s",
    async (locale) => {
      const c = twoPoint({ sourceA: 20, sourceB: 10, targetA: 0, targetB: 100, zeroOffset: 5 });
      const { texts, vm } = await execute(calibrationCode(source, c, locale), {
        sensorType: 30,
        siValues: [999, 12.5],
      });
      expect(texts).toEqual([`${calibrate(12.5, c)} cm`]);
      expect(vm.siReads).toBe(1);
      expect(vm.trace.find((entry: { op: string }) => entry.op === "INPUT_READEXT")).toMatchObject({
        port: 1,
        layer: 0,
        mode: -1,
        format: 19,
      });
    },
  );
  it("supports motor zeroing without changing the motor or using sensor commands", async () => {
    const c = { ...identityCalibration("deg"), zeroOffset: -10.25 };
    const code = calibrationCode(
      { ...source, kind: "output", type: 7, port: 0, channel: 0 },
      c,
      "en",
    );
    expect(code).not.toContain("Sensor.");
    expect(code).not.toContain("ResetCount");
    const { texts, vm } = await execute(code, { motorCount: -123 });
    expect(texts).toEqual([`${calibrate(-123, c)} deg`]);
    expect(vm.siReads).toBe(0);
  });
  it.each([
    { value: 5, calibration: twoPoint({ sourceA: 0, sourceB: 3 }) },
    {
      value: 1e10,
      calibration: twoPoint({ sourceA: -1e10, sourceB: 1e10, targetA: 0, targetB: 1 }),
    },
    {
      value: 0.0000002,
      calibration: twoPoint({ sourceA: 0, sourceB: 0.000001, targetA: 0, targetB: 1 }),
    },
    { value: 100, calibration: twoPoint({ sourceA: 0, sourceB: 1, targetA: -1e10, targetB: 0 }) },
  ])(
    "keeps large/small coefficients in float32 arithmetic ($value)",
    async ({ value, calibration }) => {
      const code = calibrationCode(source, calibration, "en");
      expect(code).not.toMatch(/\d[eE][+-]?\d/);
      const { texts } = await execute(code, { sensorType: 30, siValues: [0, value] });
      // The LCD number formatter rounds for display. Assert.Equal executes the full
      // float comparison before display so formatting is not the correctness oracle.
      expect(texts).toHaveLength(1);
      const expected = calibrate(value, calibration)!;
      const assertion = `Assert.Equal(labCalibrated, ${Math.abs(expected)} / 1${expected < 0 ? " * (0 - 1)" : ""}, "Calibration mismatch")\n`;
      const checked = await execute(code + assertion, { sensorType: 30, siValues: [0, value] });
      expect(checked.texts).toEqual(texts);
    },
  );
  it("fails visibly for a missing SI reading and does not display a fabricated zero", async () => {
    const { texts } = await execute(calibrationCode(source, twoPoint(), "en"), {
      sensorType: 30,
      siValues: [0, NaN],
    });
    expect(texts).toEqual(["Sensor reading unavailable"]);
  });
  it("checks the sensor type before selecting a mode", async () => {
    const { texts, vm } = await execute(calibrationCode(source, twoPoint(), "en"), {
      sensorType: 29,
    });
    expect(texts).toEqual(["Sensor type changed"]);
    expect(vm.modes).toEqual({});
    expect(vm.siReads).toBe(0);
  });
});
