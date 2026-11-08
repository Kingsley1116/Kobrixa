import { vi } from "vitest";
import type { PluginContext, PersistenceDrainContext } from "@kobrixa/plugin-sdk";
import type {
  RecordMeta,
  RecordWrite,
  ReservationSnapshot,
  TelemetryFrame,
  WriteProgress,
} from "@kobrixa/plugin-protocol";
import {
  LabRecorder,
  type LabRecorderStart,
} from "../../../../../plugins/sensor-lab/src/recorder.js";
import { identityCalibration } from "../../../../../plugins/sensor-lab/src/model/calibration.js";
import type { CalibratedChannel } from "../../../../../plugins/sensor-lab/src/model/data.js";
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ok = <T>(value: T) => ({ ok: true as const, value });
export const fail = () => ({
  ok: false as const,
  error: {
    code: "PLUGIN_E_STORAGE_IO" as const,
    message: "write failed",
    detail: { kind: "persistence" as const, reason: "io" as const },
  },
});
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
type TestWrite = {
  input: RecordWrite;
  bytes: Buffer;
  state: WriteProgress["state"];
  record?: RecordMeta;
};
export interface RecorderFixture {
  recorder: LabRecorder;
  options: LabRecorderStart;
  storage: PluginContext["storage"];
  devices: PluginContext["devices"];
  recording: PluginContext["devices"]["recording"];
  frame(sequence: number, elapsed?: number): TelemetryFrame;
  writes: Map<string, TestWrite>;
  change(): void;
  drain(
    reason?: PersistenceDrainContext["request"]["reason"],
    signal?: AbortSignal,
  ): PersistenceDrainContext;
  time(t: number): void;
  append(frame: TelemetryFrame): void;
  end(reason: Exclude<ReservationSnapshot["reason"], "active">): void;
  next(): void;
}
export function setup(): RecorderFixture {
  let now = 0,
    wall = 10000,
    seq = 10,
    sessionElapsed = 2_000_000,
    writeId = 100,
    revision = 0;
  let draining = false;
  const channel = {
    channelId: id(3),
    kind: "input" as const,
    portId: "input:0",
    typeId: "ev3:30",
    modeId: "mode:0",
    component: 0,
    name: "Sensor",
    modeName: "Raw",
    unit: "cm",
    decimals: 0,
    state: "ready" as const,
  };
  const channels: CalibratedChannel[] = [
    {
      source: {
        origin: "public",
        channel,
        provenance: { providerId: "kobrixa.device-ev3", sessionId: id(2), sourceRevision: 1 },
      },
      calibration: identityCalibration("cm"),
    },
  ];
  const frame = (sequence: number, elapsed = sequence - 10): TelemetryFrame => ({
    sequence,
    sampledAt: wall + elapsed,
    elapsedMs: sessionElapsed + elapsed,
    sourceRevision: 1,
    status: "ok",
    program: "stopped",
    values: [{ channelId: channel.channelId, value: sequence }],
  });
  let reservation: ReservationSnapshot = {
    reservationId: id(1),
    sessionId: id(2),
    revision: 0,
    state: "active",
    channels: [channel],
    firstSequence: seq,
    lastSequence: seq,
    reason: "active",
  };
  let frames: TelemetryFrame[] = [];
  const writes = new Map<
    string,
    { input: RecordWrite; bytes: Buffer; state: WriteProgress["state"]; record?: RecordMeta }
  >();
  let record: RecordMeta | undefined;
  const unsupported = async () => {
    throw new Error("Unexpected public API call");
  };
  const storage: PluginContext["storage"] = {
    beginWrite: vi.fn(async (input) => {
      const write = id(++writeId);
      writes.set(write, { input, bytes: Buffer.alloc(0), state: "receiving" });
      return ok({ write, id: id(50), expiresAt: 100000 });
    }),
    writeStatus: vi.fn(async ({ write }) => {
      const w = writes.get(write)!;
      return ok({
        write,
        id: id(50),
        state: w.state,
        receivedBytes: w.bytes.length,
        expiresAt: 100000,
      });
    }),
    writeChunk: vi.fn(async ({ write, offset, data }) => {
      const w = writes.get(write)!;
      if (offset !== w.bytes.length) throw new Error("offset");
      w.bytes = Buffer.concat([w.bytes, Buffer.from(data, "base64")]);
      return ok({ receivedBytes: w.bytes.length, expiresAt: 100000 });
    }),
    sealWrite: vi.fn(async ({ write }) => {
      const w = writes.get(write)!;
      w.state = "sealed";
      return ok({
        write,
        id: id(50),
        state: "sealed" as const,
        receivedBytes: w.bytes.length,
        expiresAt: 100000,
      });
    }),
    commitWrite: vi.fn(async ({ write, drainToken }) => {
      const w = writes.get(write)!;
      if (draining && !w.input.drainToken && w.state !== "committed") return fail();
      if (drainToken !== w.input.drainToken) return fail(); // actual host authorizer restriction
      if (
        w.input.target.mode === "replace" &&
        w.input.target.expectedRevision !== record?.revision &&
        w.state !== "committed"
      )
        throw new Error("CAS");
      if (!w.record) {
        w.record = {
          id: id(50),
          revision: `r_${String(++revision).padStart(32, "0")}`,
          kind: w.input.kind,
          schemaVersion: w.input.schemaVersion,
          label: w.input.label,
          mediaType: w.input.mediaType,
          byteLength: w.input.byteLength,
          sha256: w.input.sha256,
          createdAt: 10000,
          updatedAt: wall,
          checkpoint:
            w.input.checkpoint?.phase === "final" ? "final" : w.input.checkpoint ? "open" : "none",
          interrupted: false,
        };
      }
      record = w.record;
      w.state = "committed";
      return ok({
        record,
        receipt: {
          revision: record.revision,
          commitId: id(80),
          durability: "file-and-directory-sync" as const,
        },
      });
    }),
    registerCheckpoint: vi.fn(async () => ok({ checkpoint: id(60) })),
    list: vi.fn(async () => ok({ entries: [] })),
    quota: vi.fn(async () =>
      ok({
        recordCount: 0,
        reservedCreates: 0,
        committedBytes: 0,
        reservedBytes: 0,
        pinnedBytes: 0,
        temporaryBytes: 0,
        sourceLimitBytes: 536870912 as const,
        sourceLimitRecords: 256 as const,
        hostAvailableBytes: 1073741824,
        writeSlotsAvailable: 2,
        exportSlotsAvailable: 2,
      }),
    ),
    abortWrite: vi.fn(unsupported),
    stat: vi.fn(unsupported),
    openRead: vi.fn(unsupported),
    readChunk: vi.fn(unsupported),
    closeRead: vi.fn(unsupported),
    delete: vi.fn(unsupported),
    flush: vi.fn(unsupported),
    drain: vi.fn(unsupported),
    abandonCheckpoint: vi.fn(unsupported),
  };
  const recording: PluginContext["devices"]["recording"] = {
    reserve: vi.fn(async () =>
      ok({ reservation: structuredClone(reservation), firstFrame: frame(seq) }),
    ),
    query: vi.fn(async () => ok({ reservation: structuredClone(reservation) })),
    release: vi.fn(async () => {
      if (reservation.reason === "active")
        reservation = {
          ...reservation,
          reason: "released",
          state: "ended",
          revision: reservation.revision + 1,
        };
      return ok({ reservation: structuredClone(reservation) });
    }),
    read: vi.fn(async (p) => {
      const page = frames.filter((f) => f.sequence > p.afterSequence).slice(0, p.limit);
      return ok({
        reservation: structuredClone(reservation),
        frames: page,
        gap: null,
        nextSequence: page.at(-1)?.sequence ?? p.afterSequence,
        hasMore: frames.some((f) => f.sequence > (page.at(-1)?.sequence ?? p.afterSequence)),
      });
    }),
  };
  const devices: PluginContext["devices"] = {
    recording,
    connectionRecovery: { read: vi.fn(unsupported) },
    session: vi.fn(async () =>
      ok({
        session: {
          sessionId: id(2),
          providerId: "kobrixa.device-ev3",
          providerGeneration: 1,
          revision: 0,
          name: "EV3",
          transport: "mock" as const,
          capabilities: [],
          state: "connected" as const,
          foreground: "none" as const,
          recording: false,
          sourceRevision: 1,
        },
        sources: { sessionId: id(2), sourceRevision: 1, channels: [channel], actuators: [] },
      }),
    ),
    negotiate: vi.fn(unsupported),
    context: vi.fn(unsupported),
    list: vi.fn(unsupported),
    discover: vi.fn(unsupported),
    connect: vi.fn(unsupported),
    disconnect: vi.fn(unsupported),
    read: vi.fn(unsupported),
    inputModes: { query: vi.fn(unsupported), set: vi.fn(unsupported) },
    motion: {
      prepare: vi.fn(unsupported),
      start: vi.fn(unsupported),
      query: vi.fn(unsupported),
      stop: vi.fn(unsupported),
    },
    subscribe: vi.fn(unsupported),
  };
  const change = vi.fn();
  const recorder = new LabRecorder({
    devices,
    storage,
    now: () => now,
    wallNow: () => wall,
    onChange: change,
  });
  const options = { name: "Trial", sessionId: id(2), channels };
  const drain = (
    reason: PersistenceDrainContext["request"]["reason"] = "reservation-ended",
    signal = new AbortController().signal,
  ): PersistenceDrainContext => {
    draining = true;
    return {
      storage,
      signal,
      request: {
        token: id(70),
        reason,
        remainingMs: 10000,
        checkpoints: record
          ? [
              {
                checkpoint: id(60),
                record,
                reservationEnd: {
                  reservationId: reservation.reservationId,
                  reason: reservation.reason === "active" ? "retired" : reservation.reason,
                  lastSequence: reservation.lastSequence,
                },
              },
            ]
          : [],
        writes: [...writes]
          .filter(([, w]) => w.state === "receiving" || w.state === "sealed")
          .map(([write, w]) => ({ write, id: id(50), state: w.state as "receiving" | "sealed" })),
      },
    };
  };
  return {
    recorder,
    options,
    storage,
    devices,
    recording,
    frame,
    writes,
    change,
    drain,
    time: (t: number) => {
      now = t;
      wall = 10000 + t;
    },
    append: (f: TelemetryFrame) => {
      frames.push(f);
      reservation = { ...reservation, lastSequence: f.sequence };
    },
    end: (reason: Exclude<ReservationSnapshot["reason"], "active">) => {
      reservation = { ...reservation, state: "ended", reason };
    },
    next: () => {
      draining = false;
      seq = 20;
      sessionElapsed = 4_000_000;
      frames = [];
      reservation = {
        ...reservation,
        reservationId: id(5),
        revision: 0,
        state: "active",
        reason: "active",
        firstSequence: seq,
        lastSequence: seq,
      };
    },
  };
}
