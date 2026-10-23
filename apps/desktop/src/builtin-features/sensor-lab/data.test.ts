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
import type { Frame, Recording } from "../../../../../plugins/sensor-lab/src/model/data.js";
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
const origin = { providerId: "test:provider", sessionId: "session", sessionElapsedMs: 0 };
export function recording() {
  const sources = [publicSource("a"), publicSource("b")];
  return {
    schemaVersion: 2 as const,
    id: "record",
    name: "trial",
    startedAt: 0,
    durationMs: 10,
    frameCount: 1,
    recordingOrigin: origin,
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
        origin,
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
  expect(() => publicFrame(sources, frame, 0, origin)).toThrow(/duplicate/);
  expect(() => publicFrame(sources, { ...frame, sourceRevision: 4 }, 0, origin)).toThrow(
    /revision/,
  );
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
    origin,
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
      origin,
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

function timedRecording(sessionOrigin: number, sessionTimes: number[]) {
  const record = recording();
  const recordingOrigin = { ...origin, sessionElapsedMs: sessionOrigin };
  const frames = sessionTimes.map((elapsedMs, sequence) =>
    publicFrame(
      record.channels.map((c) => c.source),
      {
        sequence,
        // Receipt wall time is deliberately unrelated to the monotonic domain.
        sampledAt: 100_000 - sequence,
        elapsedMs,
        sourceRevision: 3,
        status: "ok",
        program: "stopped",
        values: [
          { channelId: "a", value: sequence },
          { channelId: "b", value: null },
        ],
      },
      0,
      recordingOrigin,
    ),
  );
  return {
    ...record,
    startedAt: 100_000,
    recordingOrigin,
    frames,
    frameCount: frames.length,
    durationMs: frames.at(-1)?.elapsedMs ?? 0,
  };
}
it("starts a zero-duration recording after more than 30 minutes of session uptime", () => {
  const input = timedRecording(1_800_001, [1_800_001]);
  const copy = snapshotRecording(input);
  expect(copy.durationMs).toBe(0);
  expect(copy.frames[0]).toMatchObject({
    elapsedMs: 0,
    sessionElapsedMs: 1_800_001,
    sampledAt: 100_000,
  });
  input.recordingOrigin.sessionElapsedMs = 0;
  expect(copy.recordingOrigin?.sessionElapsedMs).toBe(1_800_001);
  expect(Object.isFrozen(copy.recordingOrigin)).toBe(true);
});
it("crosses the 30-minute session boundary using recording-relative duration", () => {
  const record = timedRecording(1_799_900, [1_799_950, 1_800_050]);
  const copy = snapshotRecording(record);
  expect(copy.frames.map((f) => f.elapsedMs)).toEqual([50, 150]);
  expect(copy.frames.map((f) => f.sessionElapsedMs)).toEqual([1_799_950, 1_800_050]);
  expect(copy.frames.map((f) => f.sampledAt)).toEqual([100_000, 99_999]);
  expect(copy.durationMs).toBe(150);
  expect(() => snapshotRecording({ ...record, durationMs: 149 })).toThrow(/elapsedMs/);
});
it("enforces the 30-minute recording boundary independently of session age", () => {
  const origin = 3_600_000;
  expect(snapshotRecording(timedRecording(origin, [origin + LIMITS.durationMs])).durationMs).toBe(
    LIMITS.durationMs,
  );
  expect(() => timedRecording(origin, [origin + LIMITS.durationMs + 1])).toThrow(/elapsedMs/);
  expect(() => timedRecording(origin, [origin - 1])).toThrow(/elapsedMs/);
});
it.each([-1, NaN, Infinity, -Infinity])(
  "rejects invalid origin/session elapsed time %s",
  (time) => {
    expect(() => timedRecording(time, [10])).toThrow(/recordingOrigin/);
    expect(() => timedRecording(0, [time])).toThrow(/sessionElapsedMs/);
    const record = timedRecording(10, [10]);
    expect(() =>
      snapshotRecording({ ...record, recordingOrigin: { ...origin, sessionElapsedMs: time } }),
    ).toThrow(/recordingOrigin/);
    expect(() =>
      snapshotRecording({ ...record, frames: [{ ...record.frames[0]!, sessionElapsedMs: time }] }),
    ).toThrow(/sessionElapsedMs/);
  },
);
it("requires a matching recording origin and original session time in public snapshots", () => {
  const record = timedRecording(1_900_000, [1_900_010]);
  const missingOrigin: Recording = { ...record };
  delete missingOrigin.recordingOrigin;
  expect(() => snapshotRecording(missingOrigin)).toThrow(/recordingOrigin: required/);
  const empty = { ...missingOrigin, frames: [], frameCount: 0, durationMs: 0 };
  expect(() => snapshotRecording(empty)).toThrow(/recordingOrigin: required/);
  expect(snapshotRecording({ ...empty, recordingOrigin: record.recordingOrigin }).frames).toEqual(
    [],
  );
  for (const change of [{ sessionId: "other" }, { providerId: "other" }]) {
    const badOrigin = { ...record.recordingOrigin, ...change };
    expect(() => snapshotRecording({ ...record, recordingOrigin: badOrigin })).toThrow(
      /recordingOrigin: session/,
    );
    expect(() =>
      publicFrame(
        record.channels.map((c) => c.source),
        {
          sequence: 1,
          sampledAt: 0,
          elapsedMs: 1_900_010,
          sourceRevision: 3,
          status: "ok",
          program: "stopped",
          values: [],
        },
        0,
        badOrigin,
      ),
    ).toThrow(/recordingOrigin: session/);
  }
  const frame = record.frames[0]!;
  const missingSessionTime: Frame = { ...frame };
  delete missingSessionTime.sessionElapsedMs;
  expect(() => snapshotRecording({ ...record, frames: [missingSessionTime] })).toThrow(
    /sessionElapsedMs/,
  );
  expect(() =>
    snapshotRecording({ ...record, frames: [{ ...frame, sessionElapsedMs: 1_900_011 }] }),
  ).toThrow(/recording-origin/);
  expect(() =>
    snapshotRecording({
      ...record,
      recordingOrigin: { ...record.recordingOrigin, sessionElapsedMs: 1_900_001 },
    }),
  ).toThrow(/recording-origin/);
  expect(() => snapshotRecording({ ...record, frames: [{ ...frame, elapsedMs: 0 }] })).toThrow(
    /recording-origin/,
  );
});
