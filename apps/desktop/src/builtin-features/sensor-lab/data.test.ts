import { expect, it } from "vitest";
import { identityCalibration } from "../../../../../plugins/sensor-lab/src/model/calibration.js";
import {
  snapshotPublicSource,
  publicFrame,
  snapshotRecording,
  trimPreview,
  compatible,
  LIMITS,
} from "../../../../../plugins/sensor-lab/src/model/data.js";
import type { ChannelDefinition } from "../../../../../packages/plugin-protocol/src/device-types.js";
export function publicSource(id = "a") {
  return snapshotPublicSource(
    {
      channelId: id,
      kind: "input",
      portId: "in:1",
      typeId: "opaque:type",
      modeId: "opaque:mode",
      component: 2,
      name: "sensor",
      modeName: "distance",
      unit: "cm",
      decimals: 1,
      state: "ready",
    } as ChannelDefinition,
    { providerId: "test:provider", sessionId: "session", sourceRevision: 3 },
  );
}
export function recording() {
  const sources = [publicSource("a"), publicSource("b")];
  return {
    schemaVersion: 2 as const,
    id: "record",
    name: "trial",
    startedAt: 0,
    durationMs: 10,
    frameCount: 1,
    channels: sources.map((source) => ({ source, calibration: identityCalibration("cm") })),
    frames: [
      publicFrame(
        sources,
        {
          sequence: 2,
          sampledAt: 10,
          elapsedMs: 10,
          sourceRevision: 3,
          status: "ok",
          program: "stopped",
          values: [
            { channelId: "b", value: null },
            { channelId: "a", value: -5 },
          ],
        },
        0,
      ),
    ],
  };
}
it("maps by opaque ID, retains provenance, rejects duplicates/revision mismatches", () => {
  const r = recording();
  expect(r.frames[0]!.values).toEqual([-5, null]);
  expect(r.channels[0]!.source).toMatchObject({
    origin: "public",
    channel: { component: 2, typeId: "opaque:type" },
  });
  const sources = r.channels.map((c) => c.source);
  const frame = {
    sequence: 1,
    sampledAt: 1,
    elapsedMs: 1,
    sourceRevision: 3,
    status: "ok" as const,
    program: "stopped" as const,
    values: [
      { channelId: "a", value: 1 },
      { channelId: "a", value: 2 },
    ],
  };
  expect(() => publicFrame(sources, frame, 0)).toThrow(/duplicate/);
  expect(() => publicFrame(sources, { ...frame, sourceRevision: 4 }, 0)).toThrow(/revision/);
});
it("owns immutable copies and enforces recording limits", () => {
  const input = structuredClone(recording());
  const copy = snapshotRecording(input);
  input.channels[0]!.calibration.unit = "changed";
  input.frames[0]!.values[0] = 99;
  expect(copy.channels[0]!.calibration.unit).toBe("cm");
  expect(copy.frames[0]!.values[0]).toBe(-5);
  expect(Object.isFrozen(copy.frames[0]!.values)).toBe(true);
  expect(() => snapshotRecording({ ...recording(), durationMs: LIMITS.durationMs + 1 })).toThrow();
  expect(() => snapshotRecording({ ...recording(), frameCount: 2 })).toThrow();
});
it("trims time before count and compares semantics rather than labels", () => {
  const frames = Array.from({ length: 400 }, (_, i) => ({
    sampledAt: i,
    elapsedMs: i * 200,
    values: [i],
    status: "ok" as const,
    segment: 0,
  }));
  expect(trimPreview(frames)).toEqual(frames.slice(-240));
  expect(
    trimPreview([
      { ...frames[0]!, elapsedMs: 0 },
      { ...frames[1]!, elapsedMs: 60001 },
    ]),
  ).toHaveLength(1);
  const a = recording().channels[0]!;
  const b = { ...a, source: publicSource("other") };
  expect(compatible(a, b, false)).toBe(true);
  expect(compatible(a, { ...b, calibration: identityCalibration("m") }, true)).toBe(false);
  expect(
    compatible(
      a,
      {
        ...b,
        source: { ...publicSource(), channel: { ...publicSource().channel, modeId: "different" } },
      },
      false,
    ),
  ).toBe(false);
});

it("snapshots source metadata and retains public gaps without coercing identities", () => {
  const original = structuredClone(publicSource());
  const source = snapshotPublicSource(original.channel, original.provenance);
  original.channel.typeId = "changed";
  original.provenance.sourceRevision = 99;
  expect(source.channel.typeId).toBe("opaque:type");
  expect(source.provenance.sourceRevision).toBe(3);
  const frame = publicFrame(
    [source],
    {
      sequence: 9,
      sampledAt: 10,
      elapsedMs: 10,
      sourceRevision: 3,
      status: "gap",
      program: "running",
      values: [{ channelId: "a", value: null }],
      gap: { fromSequence: 4, toSequence: 8, reason: "overflow" },
    },
    2,
  );
  expect(frame).toMatchObject({
    sequence: 9,
    sourceRevision: 3,
    segment: 2,
    program: "running",
    gap: { fromSequence: 4, toSequence: 8, reason: "overflow" },
  });
  expect(() =>
    publicFrame(
      [source],
      {
        sequence: 1,
        sampledAt: 0,
        elapsedMs: 0,
        sourceRevision: 3,
        status: "ok",
        program: "stopped",
        values: [],
      },
      0,
    ),
  ).toThrow(/missing-channel/);
  const r = recording();
  r.frames[0] = { ...r.frames[0]!, sourceRevision: 4 };
  expect(() => snapshotRecording(r)).toThrow(/revision/);
  expect(() =>
    snapshotRecording({
      ...recording(),
      channels: Array.from({ length: 5 }, () => recording().channels[0]!),
    }),
  ).toThrow(/limit/);
  const record = recording();
  const frames = Array.from({ length: 3601 }, () => record.frames[0]!);
  expect(() => snapshotRecording({ ...record, frames, frameCount: frames.length })).toThrow(
    /limit/,
  );
});
