import { describe, expect, it } from "vitest";
import type { ChannelDefinition } from "@kobrixa/plugin-protocol";
import {
  channelKey,
  type SourceSnapshot,
} from "../../../../../plugins/sensor-lab/src/model/data.js";
import { identityCalibration } from "../../../../../plugins/sensor-lab/src/model/calibration.js";
import {
  ev3Channel,
  ev3SourceKey,
  compatibleEv3Sources,
  generateEv3CalibrationCode,
} from "../../../../../plugins/sensor-lab/src/ev3-source.js";

function source(patch: Partial<ChannelDefinition> = {}): SourceSnapshot {
  return {
    origin: "public",
    provenance: {
      providerId: "kobrixa.device-ev3",
      sessionId: "00000000-0000-4000-8000-000000000001",
      sourceRevision: 7,
    },
    channel: {
      channelId: "00000000-0000-4000-8000-000000000002",
      kind: "input",
      portId: "input:1",
      typeId: "ev3:30",
      modeId: "mode:2",
      component: 3,
      name: "Distance",
      modeName: "Raw",
      unit: "cm",
      decimals: 1,
      state: "ready",
      ...patch,
    },
  };
}
describe("public EV3 source adapter", () => {
  it.each([0, 1, 2, 3])("maps numeric motor port %i to the existing code generator", (port) => {
    const publicSource = source({
      kind: "output-angle",
      portId: `output:${port}`,
      typeId: "ev3:8",
      modeId: null,
      component: 0,
      unit: "deg",
    });
    const original = structuredClone(publicSource);
    const mapped = ev3Channel(publicSource);
    expect(mapped).toMatchObject({
      kind: "output",
      port,
      type: 8,
      mode: 0,
      channel: 0,
      unit: "deg",
    });
    for (const locale of ["en", "zh-TW"] as const) {
      const result = generateEv3CalibrationCode(publicSource, identityCalibration("deg"), locale);
      expect(result.available).toBe(true);
      if (result.available)
        expect(result.code).toContain(`Motor.GetCount("${String.fromCharCode(65 + port)}")`);
    }
    expect(publicSource).toEqual(original);
  });
  it("keeps nonzero input component and canonical input type/mode", () => {
    const s = source();
    expect(ev3Channel(s)).toMatchObject({ kind: "input", port: 1, type: 30, mode: 2, channel: 3 });
    const result = generateEv3CalibrationCode(s, identityCalibration("cm"), "en");
    expect(result.available && result.code).toContain("Sensor.ReadSIValue(2, 3)");
  });
  it.each([
    { portId: "input:01" },
    { portId: "input:4" },
    { portId: null },
    { typeId: "ev3:030" },
    { typeId: "ev3:0" },
    { typeId: "ev3:125" },
    { typeId: "ev3:30suffix" },
    { modeId: null },
    { modeId: "mode:02" },
    { modeId: "mode:8" },
    { component: 8 },
    { kind: "battery-percent" },
    {
      kind: "output-angle",
      portId: "output:A",
      typeId: "ev3:7",
      modeId: null,
      component: 0,
      unit: "deg",
    },
    {
      kind: "output-angle",
      portId: "output:0",
      typeId: "ev3:30",
      modeId: null,
      component: 0,
      unit: "deg",
    },
    {
      kind: "output-angle",
      portId: "output:0",
      typeId: "ev3:7",
      modeId: null,
      component: 1,
      unit: "deg",
    },
    {
      kind: "output-angle",
      portId: "output:0",
      typeId: "ev3:7",
      modeId: null,
      component: 0,
      unit: "rad",
    },
  ] satisfies Partial<ChannelDefinition>[])(
    "rejects unsupported or noncanonical tuple %j",
    (patch) => {
      expect(ev3Channel(source(patch))).toBeNull();
      expect(generateEv3CalibrationCode(source(patch), identityCalibration("cm"), "en")).toEqual({
        available: false,
        reason: "unsupported-source",
      });
    },
  );
  it("never infers EV3 from another provider or opaque identifier", () => {
    const s = source();
    if (s.origin !== "public") throw new Error("fixture");
    s.provenance.providerId = "another.provider";
    expect(ev3SourceKey(s)).toBeNull();
    expect(
      compatibleEv3Sources(
        { source: s, calibration: identityCalibration("cm") },
        { source: s, calibration: identityCalibration("cm") },
        false,
      ),
    ).toBe(false);
  });
  it("compares verified legacy/public semantics independently of live session identity", () => {
    const s = source({ state: "empty" });
    const mapped = ev3Channel(s)!;
    const legacy: SourceSnapshot = { origin: "legacy-ev3", channel: mapped };
    expect(mapped.id).toBe(channelKey(mapped));
    expect(ev3SourceKey(s)).toBe('["ev3","input",1,30,2,3,"cm"]');
    expect(ev3SourceKey(legacy)).toBe(ev3SourceKey(s));
    const a = { source: s, calibration: identityCalibration("cm") };
    const b = { source: legacy, calibration: identityCalibration("m") };
    expect(compatibleEv3Sources(a, b, false)).toBe(true);
    expect(compatibleEv3Sources(a, b, true)).toBe(false);
    expect(compatibleEv3Sources(a, { ...a, source: source({ unit: "m" }) }, false)).toBe(false);
    expect(ev3SourceKey({ origin: "legacy-ev3", channel: { ...mapped, id: "forged" } })).toBeNull();
  });
});
