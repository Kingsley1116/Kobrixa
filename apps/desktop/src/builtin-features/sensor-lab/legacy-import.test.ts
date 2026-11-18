import { expect, it } from "vitest";
import {
  importLegacyRecording,
  importLegacyCalibration,
  MAX_LEGACY_BYTES,
} from "../../../../../plugins/sensor-lab/src/model/legacy-import.js";
import { channelKey } from "../../../../../plugins/sensor-lab/src/model/data.js";
import { identityCalibration } from "../../../../../plugins/sensor-lab/src/model/calibration.js";
export const id = "12345678-1234-4234-8234-123456789abc";
export function legacy() {
  const source = {
    id: "",
    kind: "input" as const,
    port: 0,
    type: 30,
    mode: 0,
    channel: 1,
    name: "US",
    modeName: "distance",
    unit: "cm",
    decimals: 1,
  };
  source.id = channelKey(source);
  return {
    schemaVersion: 1,
    id,
    name: "trial",
    startedAt: 100,
    durationMs: 1000,
    frameCount: 2,
    device: { id: "brick", name: "EV3", transport: "usb" },
    channels: [{ source, calibration: identityCalibration("cm") }],
    frames: [
      { sampledAt: 200, elapsedMs: 0, values: [null], status: "busy", segment: 0 },
      { sampledAt: 1200, elapsedMs: 1000, values: [3], status: "ok", segment: 1 },
    ],
  };
}
export const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
it("deterministically maps recovery without losing raw frames or legacy provenance", () => {
  const input = legacy();
  const a = importLegacyRecording(bytes(input), id);
  const b = importLegacyRecording(bytes(input), id);
  expect(a).toEqual(b);
  expect(a.ok).toBe(true);
  if (a.ok) {
    expect(a.value).toMatchObject({
      schemaVersion: 2,
      endedAt: 1200,
      reason: "interrupted",
      provenance: { origin: "legacy-ev3", schemaVersion: 1, device: input.device },
    });
    expect(a.value.frames).toEqual(input.frames);
    expect(a.value.channels[0]!.source).toEqual({
      origin: "legacy-ev3",
      channel: input.channels[0]!.source,
    });
  }
  const empty = { ...input, frames: [], frameCount: 0 };
  const result = importLegacyRecording(bytes(empty), id);
  if (result.ok) expect(result.value.endedAt).toBe(100);
  else throw Error("empty recovery failed");
});
it("rejects malformed/oversized bytes, strict shapes, forged identity and invalid frames", () => {
  for (const value of [
    new Uint8Array(MAX_LEGACY_BYTES + 1),
    new Uint8Array([0xff]),
    bytes({}),
    bytes({ ...legacy(), schemaVersion: 9 }),
    bytes({ ...legacy(), extra: 1 }),
    bytes({ ...legacy(), endedAt: 3 }),
    bytes({ ...legacy(), frameCount: 3 }),
  ])
    expect(importLegacyRecording(value, id).ok).toBe(false);
  expect(importLegacyRecording(bytes(legacy()), "other").ok).toBe(false);
  const bad = legacy();
  bad.channels[0]!.source.id = "forged";
  expect(importLegacyRecording(bytes(bad), id).ok).toBe(false);
  const reversed = legacy();
  reversed.frames[1]!.elapsedMs = -1;
  expect(importLegacyRecording(bytes(reversed), id).ok).toBe(false);
});
it("accepts only the actual calibration envelope with matching profile identity", () => {
  const profile = { id, name: "profile", ...legacy().channels[0]! };
  expect(importLegacyCalibration(bytes({ schemaVersion: 1, profile }), id).ok).toBe(true);
  expect(importLegacyCalibration(bytes(profile), id).ok).toBe(false);
  expect(importLegacyCalibration(bytes({ schemaVersion: 1, profile }), "other").ok).toBe(false);
});

it("matches strict legacy limits, motor restrictions and terminal semantics", () => {
  const cases: Array<(r: ReturnType<typeof legacy>) => unknown> = [
    (r) => ({ ...r, name: " " }),
    (r) => ({ ...r, device: { ...r.device, unknown: true } }),
    (r) => ({ ...r, durationMs: 1_800_001 }),
    (r) => ({ ...r, frames: [{ ...r.frames[0]!, values: [] }], frameCount: 1 }),
    (r) => ({
      ...r,
      frames: [
        { ...r.frames[0]!, elapsedMs: 10 },
        { ...r.frames[1]!, elapsedMs: 9 },
      ],
    }),
    (r) => ({ ...r, frames: [{ ...r.frames[0]!, elapsedMs: 1001 }], frameCount: 1 }),
    (r) => ({ ...r, channels: [r.channels[0], r.channels[0]] }),
    (r) => {
      r.channels[0]!.calibration.zeroOffset = 1e40;
      return r;
    },
    (r) => {
      const s = r.channels[0]!.source;
      Object.assign(s, { kind: "output", type: 30, unit: "deg" });
      s.id = channelKey(s);
      return r;
    },
    (r) => {
      r.channels[0]!.source.unit = "deg";
      r.channels[0]!.source.kind = "output" as "input";
      r.channels[0]!.source.type = 7;
      r.channels[0]!.source.id = channelKey(r.channels[0]!.source);
      return r;
    },
  ];
  for (const change of cases)
    expect(importLegacyRecording(bytes(change(legacy())), id).ok).toBe(false);
  const ended = { ...legacy(), endedAt: 1300, reason: "manual" };
  const result = importLegacyRecording(bytes(ended), id);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.reason).toBe("manual");
  expect(importLegacyRecording(new Uint8Array(MAX_LEGACY_BYTES + 1), id)).toEqual({
    ok: false,
    errors: [{ path: "bytes", code: "size" }],
  });
  expect(importLegacyRecording(new Uint8Array(MAX_LEGACY_BYTES), id)).toEqual({
    ok: false,
    errors: [{ path: "bytes", code: "encoding-or-json" }],
  });
});
