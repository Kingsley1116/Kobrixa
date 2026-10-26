import { describe, expect, it } from "vitest";
import { BasicPlusFrontend } from "../../../../../frontends/basic-plus/src/index.js";
import { EV3Backend } from "../../../../../packages/backend-ev3/src/index.js";
import { validateIR } from "../../../../../packages/ir/src/index.js";
// @ts-expect-error The existing bytecode regression VM is implemented in JavaScript.
import { decode, VM } from "../../../../../tests/bytecode/support/ev3-vm.mjs";
import type {
  SensorCalibration,
  SensorChannel,
} from "../../../../../plugins/sensor-lab/src/model/data.js";
import {
  generateCalibrationCode,
  calibrate,
  calibrationCode,
  identityCalibration,
  validateCalibration,
} from "../../../../../plugins/sensor-lab/src/model/calibration.js";

import {
  calibrationCode as legacyCalibrationCode,
  calibrate as legacyCalibrate,
} from "../../shared/sensor-calibration.js";

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

async function execute(code: string, scenario: Record<string, unknown>, status = "ended") {
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
  // The shared VM does not trace metadata/readiness or mode-selection operations.
  // Observe their input operands without replacing any instruction semantics.
  const operations: { op: string; args: unknown[] }[] = [];
  const instruction = vm.execute.bind(vm);
  vm.execute = (i: { name: string; args: unknown[] }) => {
    const inputs: Record<string, number> = {
      "INPUT_DEVICE.GET_TYPEMODE": 3,
      "INPUT_DEVICE.GET_FORMAT": 3,
      "INPUT_DEVICE.READY_RAW": 6,
      INPUT_READEXT: 6,
      INPUT_TEST: 2,
      INPUT_READY: 2,
      OUTPUT_GET_COUNT: 2,
    };
    if (i.name.startsWith("INPUT_") || i.name.startsWith("OUTPUT_"))
      operations.push({
        op: i.name,
        args: i.args.slice(0, inputs[i.name] ?? i.args.length).map((arg) => vm.read(arg)),
      });
    return instruction(i);
  };
  const run = vm.run();
  expect(run.status, run.error).toBe(status);
  return {
    vm,
    run,
    operations,
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

it("reports opaque public sources as unavailable and rejects invalid numeric sources", async () => {
  const publicSource = () => ({
    origin: "public" as const,
    channel: {
      channelId: "opaque",
      kind: "input" as const,
      portId: "in:1",
      typeId: "opaque:type",
      modeId: "opaque:mode",
      component: 0,
      name: "sensor",
      modeName: "mode",
      unit: "cm",
      decimals: 1,
      state: "ready" as const,
    },
    provenance: { providerId: "test:provider", sessionId: "session", sourceRevision: 1 },
  });
  expect(generateCalibrationCode(publicSource(), identityCalibration("cm"), "en")).toEqual({
    available: false,
    reason: "unsupported-source",
  });
  expect(
    generateCalibrationCode(
      { origin: "legacy-ev3", channel: { ...source, port: 9 } },
      identityCalibration("cm"),
      "en",
    ),
  ).toEqual({ available: false, reason: "invalidSource" });
});

// Independent OLD/NEW entry points receive the very same frozen inputs. Literal
// expectations are deliberately not computed by either implementation.
const differentialCases = [
  {
    name: "reversed nonzero channel",
    value: 12.5,
    c: twoPoint({ sourceA: 20, sourceB: 10, zeroOffset: 5 }),
    expected: 70,
    text: "70 cm",
  },
  { name: "zero endpoint", value: 10, c: twoPoint(), expected: 0, text: "0 cm" },
  { name: "extrapolation", value: 70, c: twoPoint(), expected: 150, text: "150 cm" },
  {
    name: "float32 rounding",
    value: 5,
    c: twoPoint({ sourceA: 0, sourceB: 3 }),
    expected: 166.6666717529297,
    text: "166.667 cm",
  },
  {
    name: "small coefficients",
    value: 0.0000002,
    c: twoPoint({ sourceA: 0, sourceB: 0.000001, targetB: 1 }),
    expected: 0.20000000298023224,
    text: "0.2 cm",
  },
  {
    name: "large coefficients",
    value: 1e10,
    c: twoPoint({ sourceA: -1e10, sourceB: 1e10, targetB: 1 }),
    expected: 1,
    text: "1 cm",
  },
  {
    name: "overflow",
    value: 3e38,
    c: twoPoint(),
    expected: null,
    text: "Calibration result unavailable",
  },
  {
    name: "missing SI",
    value: NaN,
    c: twoPoint(),
    expected: null,
    text: "Sensor reading unavailable",
  },
  {
    name: "infinite SI",
    value: Infinity,
    c: twoPoint(),
    expected: null,
    // Sensor.ReadSIValue lowers non-finite SI to NaN before calibration.
    text: "Sensor reading unavailable",
  },
].map((item) => Object.freeze({ ...item, c: Object.freeze(item.c) }));

const differentialSource = Object.freeze({ ...source, port: 3, mode: 2, channel: 2 });

describe.each(["en", "zh-TW"] as const)("actual legacy/new codegen parity (%s)", (locale) => {
  async function compare(
    channel: SensorChannel,
    c: SensorCalibration,
    scenario: Record<string, unknown>,
    assertion = "",
    status = "ended",
  ) {
    const old = await execute(
      legacyCalibrationCode(channel, c, locale) + assertion,
      scenario,
      status,
    );
    const next = await execute(calibrationCode(channel, c, locale) + assertion, scenario, status);
    // No trace normalization: preserve order, operands, output, and error text.
    expect(next.run.trace).toEqual(old.run.trace);
    expect(next.run.status).toBe(old.run.status);
    expect(next.run.error).toBe(old.run.error);
    expect(next.operations).toEqual(old.operations);
    expect(next.vm.modes).toEqual(old.vm.modes);
    expect(next.vm.siReads).toBe(old.vm.siReads);
    expect(next.texts).toEqual(old.texts);
    return next;
  }

  it.each(differentialCases)("$name", async ({ value, c, expected, text }) => {
    expect(legacyCalibrate(value, c)).toBe(expected);
    expect(calibrate(value, c)).toBe(expected);
    const scenario = Object.freeze({ sensorType: 30, siValues: Object.freeze([999, -999, value]) });
    // Check the full float32 value inside BOTH compiled programs, before relying
    // on LCD formatting. The oracle is a literal fixture, not the new calibrator.
    const assertion =
      expected === null
        ? ""
        : `Assert.Equal(labCalibrated, ${expected} / 1, "Parity numeric mismatch")\n`;
    const result = await compare(differentialSource, c, scenario, assertion);
    expect(result.texts).toEqual([text]);
    expect(result.vm.siReads).toBe(1);
    expect(result.vm.modes).toEqual({ 3: 2 });
    const metadata = { op: "INPUT_DEVICE.GET_TYPEMODE", args: [5, 0, 3] };
    const ready = { op: "INPUT_TEST", args: [0, 3] };
    expect(result.operations).toEqual([
      metadata,
      { op: "INPUT_DEVICE.READY_RAW", args: [28, 0, 3, 0, 2, 1] },
      { op: "INPUT_READY", args: [0, 3] },
      metadata,
      metadata,
      ready,
      metadata,
      { op: "INPUT_DEVICE.GET_FORMAT", args: [2, 0, 3] },
      { op: "INPUT_READEXT", args: [0, 3, 0, -1, 19, 8] },
      metadata,
      ready,
      metadata,
      metadata,
    ]);
    expect(
      result.run.trace.filter((entry: { op: string }) => entry.op === "INPUT_READEXT"),
    ).toEqual([
      { op: "INPUT_READEXT", layer: 0, port: 3, mode: -1, format: 19, values: scenario.siValues },
    ]);
    expect(result.operations.some((entry) => entry.op.startsWith("OUTPUT_"))).toBe(false);
  });

  it("preserves motor count and never issues reset or sensor operations", async () => {
    const channel = Object.freeze({
      ...source,
      kind: "output" as const,
      type: 7,
      port: 2,
      channel: 0,
    });
    const c = Object.freeze({ ...identityCalibration("deg"), zeroOffset: -10.25 });
    expect(legacyCalibrate(-123, c)).toBe(-112.75);
    expect(calibrate(-123, c)).toBe(-112.75);
    const result = await compare(channel, c, Object.freeze({ motorCount: -123 }));
    expect(result.texts).toEqual(["-112.75 deg"]);
    expect(result.operations).toEqual([{ op: "OUTPUT_GET_COUNT", args: [0, 2] }]);
    expect(result.vm.modes).toEqual({});
    expect(result.vm.siReads).toBe(0);
  });

  it("rejects a type mismatch before changing mode or reading", async () => {
    const result = await compare(
      differentialSource,
      differentialCases[0]!.c,
      Object.freeze({ sensorType: 29 }),
    );
    expect(result.texts).toEqual(["Sensor type changed"]);
    expect(result.operations).toEqual([{ op: "INPUT_DEVICE.GET_TYPEMODE", args: [5, 0, 3] }]);
    expect(result.vm.modes).toEqual({});
    expect(result.vm.siReads).toBe(0);
  });

  it("preserves an absent SI component without fabricating zero", async () => {
    const result = await compare(
      differentialSource,
      differentialCases[0]!.c,
      Object.freeze({ sensorType: 30, sensorDatasets: 3, siValues: Object.freeze([999]) }),
    );
    expect(result.texts).toEqual(["Sensor reading unavailable"]);
    expect(result.vm.siReads).toBe(1);
  });

  it("keeps invalid legacy sources throwing while the new wrapper reports availability", () => {
    const channel = Object.freeze({ ...differentialSource, port: 9 });
    const c = differentialCases[0]!.c;
    expect(() => legacyCalibrationCode(channel, c, locale)).toThrow(
      new RangeError("invalidSource"),
    );
    expect(() => calibrationCode(channel, c, locale)).toThrow(new RangeError("invalidSource"));
    expect(generateCalibrationCode({ origin: "legacy-ev3", channel }, c, locale)).toEqual({
      available: false,
      reason: "invalidSource",
    });
  });

  it("preserves real VM errors", async () => {
    const result = await compare(
      differentialSource,
      differentialCases[0]!.c,
      Object.freeze({ sensorType: 30, siSamples: Object.freeze([]) }),
      "",
      "error",
    );
    expect(result.run.error).toBe("SI sensor scenario exhausted");
    expect(result.texts).toEqual([]);
  });

  it.each([null, undefined, NaN, Infinity])("preserves missing model value %s", (value) => {
    expect(legacyCalibrate(value, differentialCases[0]!.c)).toBeNull();
    expect(calibrate(value, differentialCases[0]!.c)).toBeNull();
  });

  it.each([
    { c: twoPoint({ sourceA: 1, sourceB: 1 + 1e-10 }), error: "sameSource" },
    { c: twoPoint({ targetA: Infinity }), error: "nonFinite" },
    { c: twoPoint({ zeroOffset: 1e40 }), error: "float32Range" },
    { c: twoPoint({ unit: "cm\n" }), error: "invalidUnit" },
  ])("preserves generation errors: $error", ({ c, error }) => {
    Object.freeze(c);
    expect(() => legacyCalibrationCode(differentialSource, c, locale)).toThrow(
      new RangeError(error),
    );
    expect(() => calibrationCode(differentialSource, c, locale)).toThrow(new RangeError(error));
    // Intentional new API deviation: availability result instead of throwing.
    expect(
      generateCalibrationCode({ origin: "legacy-ev3", channel: differentialSource }, c, locale),
    ).toEqual({ available: false, reason: error });
  });
});
