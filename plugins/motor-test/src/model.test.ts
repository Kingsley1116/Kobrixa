import { describe, expect, it } from "vitest";
import {
  DEVICE_LIMITS_V1,
  actuatorDefinitionSchema,
  deviceSessionSnapshotSchema,
  motionSnapshotSchema,
  motionSpecSchema,
  sourceCatalogSchema,
  type MotionSnapshot,
  type MotionSpec,
} from "@kobrixa/plugin-protocol";
import {
  DEFAULTS,
  PORTS,
  availabilityText,
  boundedText,
  fieldKey,
  initialForm,
  localize,
  motionFromForm,
  presentMotion,
  progress,
  selectSource,
  selectionCurrent,
  stopBrake,
} from "./model.js";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const actuator = actuatorDefinitionSchema.parse({
  actuatorId: id,
  portId: "A",
  name: "Motor",
  typeId: "large",
  state: "ready",
});
const session = deviceSessionSnapshotSchema.parse({
  sessionId: id,
  providerId: "kobrixa.ev3",
  providerGeneration: 1,
  revision: 1,
  name: "EV3",
  transport: "usb",
  capabilities: ["finiteMotion.v1"],
  state: "connected",
  foreground: "none",
  recording: false,
  sourceRevision: 1,
});
const sources = sourceCatalogSchema.parse({
  sessionId: id,
  sourceRevision: 1,
  channels: [],
  actuators: [actuator],
});
const snapshot = (changes: Partial<MotionSnapshot> = {}): MotionSnapshot =>
  motionSnapshotSchema.parse({
    operationId: id,
    sessionId: id,
    revision: 1,
    phase: "running",
    stage: "moving",
    startAccepted: true,
    stopRequested: false,
    dispatch: "sent",
    movement: "unknown",
    stopConfirmation: "pending",
    brakeRequired: false,
    elapsedMs: 0,
    angle: null,
    displacement: null,
    preparedRemainingMs: 0,
    ...changes,
  });
const spec = (mode: MotionSpec["mode"]): MotionSpec =>
  motionSpecSchema.parse({
    actuatorId: id,
    power: 20,
    direction: 1,
    brake: true,
    mode,
    ...(mode === "timed" ? { durationMs: 1000 } : mode === "relative-angle" ? { degrees: 90 } : {}),
  });

function build(
  mode: MotionSpec["mode"],
  changes: Record<string, unknown> = {},
  jogDirection: 1 | -1 = 1,
) {
  // Boundary fixtures include malformed input to verify runtime validation, not just TS types.
  const form = { ...initialForm(), "a-mode": mode, ...changes };
  return motionFromForm(form as ReturnType<typeof initialForm>, actuator, jogDirection);
}
function expectInvalid(result: ReturnType<typeof build>, field: string) {
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.fieldErrors).toContainEqual({
      field,
      message: expect.objectContaining({ en: expect.any(String), "zh-TW": expect.any(String) }),
    });
}

describe("public form to strict MotionSpec", () => {
  it("creates independent defaults for all four ports", () => {
    const form = initialForm();
    expect(Object.keys(form)).toHaveLength(25);
    expect(form.port).toBe("A");
    for (const port of PORTS)
      for (const [key, value] of Object.entries(DEFAULTS))
        expect(form[fieldKey(port, key as keyof typeof DEFAULTS)]).toBe(value);
    form["b-power"] = 99;
    expect(initialForm()["b-power"]).toBe(20);
    expect(form["a-power"]).toBe(20);
  });
  it.each([0, 101, 1.5, NaN, Infinity, -Infinity, "20", "", " ", null, undefined])(
    "rejects invalid power %s",
    (power) => expectInvalid(build("jog", { "a-power": power }), "a-power"),
  );
  it.each([1, 100])("accepts power boundary %s", (power) => {
    const result = build("jog", { "a-power": power });
    expect(result).toMatchObject({ ok: true, spec: { power } });
  });
  it.each([0.099, 5.001, NaN, Infinity, "1", "", null])(
    "rejects invalid seconds %s before rounding",
    (seconds) => expectInvalid(build("timed", { "a-seconds": seconds }), "a-seconds"),
  );
  it.each([
    [0.1, 100],
    [5, 5000],
    [1.2344, 1234],
    [1.2345, 1235],
    [0.10049, 100],
    [0.1005, 101],
  ])("rounds %s seconds to %s ms", (seconds, durationMs) => {
    expect(build("timed", { "a-seconds": seconds })).toMatchObject({
      ok: true,
      spec: { mode: "timed", durationMs },
    });
  });
  it.each([0, 3601, 1.5, NaN, Infinity, "90", "", null])("rejects invalid degrees %s", (degrees) =>
    expectInvalid(build("relative-angle", { "a-degrees": degrees }), "a-degrees"),
  );
  it.each([1, 3600])("accepts angle boundary %s", (degrees) =>
    expect(build("relative-angle", { "a-degrees": degrees })).toMatchObject({
      ok: true,
      spec: { degrees },
    }),
  );
  it.each(["jog", "timed", "relative-angle"] as const)(
    "emits only public %s variant fields",
    (mode) => {
      const result = build(mode);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(motionSpecSchema.parse(result.spec)).toEqual(result.spec);
      expect(Object.keys(result.spec).sort()).toEqual(
        [
          "actuatorId",
          "power",
          "direction",
          "brake",
          "mode",
          ...(mode === "timed" ? ["durationMs"] : mode === "relative-angle" ? ["degrees"] : []),
        ].sort(),
      );
      expect(
        motionSpecSchema.safeParse({
          ...result.spec,
          ...(mode === "timed" ? { degrees: 90 } : { durationMs: 1000 }),
        }).success,
      ).toBe(false);
    },
  );
  it.each(["jog", "timed", "relative-angle"] as const)(
    "ignores inactive fields for %s and other ports",
    (mode) => {
      const changes: Record<string, unknown> = {};
      for (const port of PORTS)
        for (const key of Object.keys(DEFAULTS))
          changes[fieldKey(port, key as keyof typeof DEFAULTS)] = null;
      Object.assign(changes, { "a-mode": mode, "a-power": 20, "a-brake": true });
      if (mode !== "jog") changes["a-direction"] = "-1";
      if (mode === "timed") changes["a-seconds"] = 1;
      if (mode === "relative-angle") changes["a-degrees"] = 90;
      expect(build(mode, changes, -1)).toMatchObject({ ok: true, spec: { direction: -1 } });
    },
  );
  it.each([null, "", 1, true])("rejects active direction %s", (direction) =>
    expectInvalid(build("timed", { "a-direction": direction }), "a-direction"),
  );
  it.each([null, "true", 1])("rejects brake %s", (brake) =>
    expectInvalid(build("jog", { "a-brake": brake }), "a-brake"),
  );
  it("requires a real jog button direction, not the draft direction", () => {
    expectInvalid(motionFromForm(initialForm(), actuator), "a-direction");
    expect(build("jog", { "a-direction": "invalid" }, -1)).toMatchObject({
      ok: true,
      spec: { direction: -1 },
    });
  });
  it("rejects unknown port/mode and stale/unready actuators", () => {
    expectInvalid(build("jog", { port: "E" }), "port");
    expectInvalid(build("jog", { "a-mode": "angle" }), "a-mode");
    expect(() => motionFromForm(initialForm(), { ...actuator, portId: "B" }, 1)).toThrow(TypeError);
    expect(() => motionFromForm(initialForm(), { ...actuator, state: "empty" }, 1)).toThrow(
      TypeError,
    );
    expect(() => motionFromForm(initialForm(), { ...actuator, actuatorId: "A" }, 1)).toThrow();
  });
});

describe("source selection is separate from drafts and operations", () => {
  it("uses a public catalog handle and invalidates replacements", () => {
    const selected = selectSource(session, sources, "A")!;
    expect(selected).toEqual({ sessionId: id, sourceRevision: 1, portId: "A", actuatorId: id });
    expect(selectionCurrent(selected, session, sources)).toBe(true);
    expect(
      selectionCurrent(
        selected,
        { ...session, sourceRevision: 2 },
        { ...sources, sourceRevision: 2 },
      ),
    ).toBe(false);
    expect(
      selectionCurrent(selected, session, {
        ...sources,
        actuators: [{ ...actuator, actuatorId: otherId }],
      }),
    ).toBe(false);
    expect(
      selectionCurrent(
        selected,
        { ...session, sessionId: otherId },
        { ...sources, sessionId: otherId },
      ),
    ).toBe(false);
  });
  it.each(["empty", "unknown", "initializing", "error"] as const)("refuses %s actuators", (state) =>
    expect(
      selectSource(session, { ...sources, actuators: [{ ...actuator, state }] }, "A"),
    ).toBeNull(),
  );
  it("refuses absent, ambiguous, unsupported and stale sources", () => {
    expect(selectSource(session, sources, "D")).toBeNull();
    expect(selectSource(session, { ...sources, actuators: [actuator, actuator] }, "A")).toBeNull();
    expect(selectSource({ ...session, capabilities: [] }, sources, "A")).toBeNull();
    expect(selectSource({ ...session, state: "quarantined" }, sources, "A")).toBeNull();
    expect(selectSource(session, { ...sources, sessionId: otherId }, "A")).toBeNull();
    expect(selectSource(session, { ...sources, sourceRevision: 2 }, "A")).toBeNull();
  });
});

describe("bounded broker presentation", () => {
  it.each([
    ["timed", 500, null, 0.5],
    ["timed", 5000, null, 1],
    ["jog", 5000, null, 0.5],
    ["jog", 11000, null, 1],
    ["relative-angle", 0, -45, 0.5],
    ["relative-angle", 0, 9000, 1],
    ["relative-angle", 0, 0, 0],
    ["relative-angle", 0, null, null],
  ] as const)("computes %s progress", (mode, elapsedMs, displacement, expected) =>
    expect(progress(snapshot({ elapsedMs, displacement }), spec(mode))).toBe(expected),
  );
  it("keeps no angle/displacement distinct from zero", () => {
    expect(presentMotion(snapshot(), spec("relative-angle"), "en").data).toMatchObject({
      angle: "No reading",
      displacement: "No reading",
      progress: null,
    });
    expect(
      presentMotion(snapshot({ angle: 0, displacement: 0 }), spec("relative-angle"), "zh-TW").data,
    ).toMatchObject({ angle: "0°", displacement: "0°", progress: 0 });
  });
  for (const phase of [
    "preparing",
    "running",
    "stopping",
    "completed",
    "stopped",
    "timeout",
    "failed",
    "unconfirmed",
  ] as const) {
    it.each(["not-required", "pending", "confirmed", "unconfirmed"] as const)(
      `${phase} preserves %s confirmation independently`,
      (stopConfirmation) => {
        const state = snapshot({
          phase,
          stopConfirmation,
          stopRequested: true,
          dispatch: "unknown",
          movement: "timed-out",
          stage: "readback",
        });
        const en = presentMotion(state, spec("timed"), "en");
        const zh = presentMotion(state, spec("timed"), "zh-TW");
        expect(en.stoppedConfirmed).toBe(stopConfirmation === "confirmed");
        expect(en.terminal).toBe(!["preparing", "running", "stopping"].includes(phase));
        expect(en.data).toMatchObject({
          dispatch: "Unknown",
          movement: "Timed out",
          "stop-requested": "Yes",
          stage: "Reading back",
        });
        expect(zh.data.phase).not.toBe(en.data.phase);
        expect(zh.data.confirmation).not.toBe(en.data.confirmation);
      },
    );
  }
  it("never downgrades required or forced braking", () => {
    expect(stopBrake(false, snapshot())).toBe(false);
    expect(stopBrake(true, snapshot())).toBe(true);
    expect(stopBrake(false, snapshot({ brakeRequired: true }))).toBe(true);
    expect(stopBrake(false, snapshot(), true)).toBe(true);
  });
  it("preserves public error classification and bounds only rendered text", () => {
    const error: NonNullable<MotionSnapshot["error"]> = {
      code: "PLUGIN_E_DEVICE_STOP_UNCONFIRMED",
      message: "讀".repeat(1500),
      detail: {
        kind: "device",
        reason: "readback-failed",
        dispatch: "unknown",
        stopConfirmation: "unconfirmed",
      },
    };
    const result = presentMotion(snapshot({ error, phase: "failed" }), spec("jog"), "zh-TW");
    expect(result.error).toEqual(error);
    expect(Array.from(result.data.error)).toHaveLength(1000);
    expect(result.stoppedConfirmed).toBe(false);
    expect(boundedText("a\n\u0000\ud800😀")).toBe("a😀");
    for (const value of Object.values(availabilityText))
      expect(localize(value, "en")).not.toBe(localize(value, "zh-TW"));
  });
  it("uses existing host budgets without adding scheduling", () => {
    expect(DEVICE_LIMITS_V1).toMatchObject({
      movementMs: 10000,
      jogPulseMs: 400,
      intentMs: 350,
      stopMs: 15000,
    });
    expect(progress(snapshot({ elapsedMs: DEVICE_LIMITS_V1.movementMs }), spec("jog"))).toBe(1);
  });
});

// Transferred legacy controls assertions: independent port drafts and three movement modes.
describe("retired desktop motor controls parity", () => {
  it.each(PORTS)(
    "keeps %s defaults independent and emits only the selected mode fields",
    (port) => {
      for (const mode of ["jog", "timed", "relative-angle"] as const) {
        const form = initialForm();
        expect(form[fieldKey(port, "power")]).toBe(20);
        expect(form[fieldKey(port, "seconds")]).toBe(1);
        expect(form[fieldKey(port, "degrees")]).toBe(90);
        form.port = port;
        form[fieldKey(port, "mode")] = mode;
        const result = motionFromForm(form, { ...actuator, portId: port }, -1);
        expect(result.ok).toBe(true);
        if (!result.ok) throw Error("Expected valid default");
        expect(result.spec).toMatchObject({
          mode,
          power: 20,
          brake: true,
          direction: mode === "jog" ? -1 : 1,
        });
        expect("durationMs" in result.spec).toBe(mode === "timed");
        expect("degrees" in result.spec).toBe(mode === "relative-angle");
        expect(initialForm()[fieldKey(port, "mode")]).toBe("jog");
      }
    },
  );
  it("preserves elapsed/absolute-angle progress and clamp", () => {
    expect(progress(snapshot({ elapsedMs: 250 }), spec("timed"))).toBe(0.25);
    expect(progress(snapshot({ displacement: -45 }), spec("relative-angle"))).toBe(0.5);
    expect(progress(snapshot({ elapsedMs: 20000 }), spec("timed"))).toBe(1);
    expect(progress(snapshot({ displacement: null }), spec("relative-angle"))).toBeNull();
  });
});
