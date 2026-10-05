import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import { identityCalibration } from "../../shared/sensor-calibration.js";
import {
  monitorChannels,
  type MonitorUpdate,
  type SensorLabStartRequest,
} from "../../shared/sensor-lab.js";
import { SensorLabService } from "./service.js";
import { SensorLabStore, atomicSensorLabWrite } from "./store.js";
import { SENSOR_LAB_LIMITS, sensorLabStartSchema } from "./schema.js";

const directories: string[] = [];
const services: SensorLabService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose().catch(() => {});
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const HOST_TIME = 1_780_000_000_000;
function snapshot(value: number | null = 12.5, mode = 0): DeviceMonitorSnapshot {
  return {
    sampledAt: HOST_TIME,
    battery: { percent: 75, voltage: 7.5 },
    program: { status: "stopped", rawStatus: 64, result: 0 },
    inputs: [
      {
        port: 0,
        type: 29,
        connection: 122,
        mode,
        state: "ready",
        name: "Color",
        modeName: "COL-REFLECT",
        unit: "%",
        decimals: 1,
        values: [value],
        switchable: true,
      },
    ],
    outputs: [{ port: 0, type: 7, state: "ready", name: "Large motor", angle: 42 }],
  };
}
async function setup(options: { directory?: string; store?: SensorLabStore } = {}) {
  const directory =
    options.directory ?? (await mkdtemp(path.join(os.tmpdir(), "kobrixa-sensor-lab-")));
  if (!options.directory) directories.push(directory);
  const sessionId = randomUUID();
  let elapsed = 0;
  let clockOffset = 0;
  let sequence = 1;
  let latest: MonitorUpdate = { sessionId, sequence, status: "live", snapshot: snapshot() };
  const acquire = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const store = options.store ?? new SensorLabStore(directory);
  const service = new SensorLabService({
    directory,
    acquire,
    release,
    device: () => ({ id: "usb-test", name: "EV3", transport: "usb" }),
    publish: () => {},
    latest: () => latest,
    now: () => HOST_TIME + elapsed + clockOffset,
    monotonic: () => elapsed,
    store,
  });
  services.push(service);
  const source = monitorChannels(snapshot())[0]!;
  const request: SensorLabStartRequest = {
    sessionId,
    name: "Reflection test",
    channels: [{ source, calibration: identityCalibration(source.unit) }],
  };
  const emit = (patch: Partial<MonitorUpdate> = {}, at = elapsed + 500) => {
    elapsed = at;
    const current = patch.snapshot ?? snapshot();
    current.sampledAt = HOST_TIME + elapsed + clockOffset;
    latest = { sessionId, sequence: ++sequence, status: "live", snapshot: current, ...patch };
    service.observe(latest);
    return latest;
  };
  return {
    service,
    store,
    directory,
    sessionId,
    acquire,
    release,
    request,
    emit,
    advance: (value: number) => {
      elapsed = value;
    },
    adjustClock: (value: number) => {
      clockOffset = value;
    },
    setLatest: (value: MonitorUpdate) => {
      latest = value;
    },
  };
}

describe("SensorLabService", () => {
  it("records one shared stream, fixes channel/calibration metadata and rejects duplicate replies", async () => {
    const h = await setup();
    const started = await h.service.start(h.request);
    expect(started).toMatchObject({ active: true, saved: true });
    expect(h.acquire).toHaveBeenCalledWith(h.sessionId);
    h.request.channels[0]!.calibration.zeroOffset = 99;
    const update = h.emit({ snapshot: snapshot(24.5) });
    h.service.observe(update);
    h.service.observe({ ...update, sessionId: randomUUID(), sequence: 999 });
    const state = await h.service.stop();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(state.recording?.frames.map((frame) => frame.values)).toEqual([[12.5], [24.5]]);
    expect(state.recording?.channels[0]!.calibration.zeroOffset).toBe(0);
    expect(state.recording).toMatchObject({ durationMs: 500, frameCount: 2, reason: "manual" });
    const reopened = new SensorLabStore(h.directory);
    expect(await reopened.read(state.recording!.id)).toEqual(state.recording);
  });

  it("records busy, errors and invalid values as gaps without reusing the previous snapshot", async () => {
    const h = await setup();
    await h.service.start(h.request);
    h.emit({ status: "waiting", snapshot: snapshot(99) });
    h.emit({ status: "error", snapshot: snapshot(100), error: "temporary timeout" });
    h.emit({ snapshot: snapshot(null) });
    h.emit({ snapshot: snapshot(16.75) });
    const record = (await h.service.stop()).recording!;
    expect(record.frames.map(({ values }) => values)).toEqual([
      [12.5],
      [null],
      [null],
      [null],
      [16.75],
    ]);
    expect(record.frames.map(({ status }) => status)).toEqual(["ok", "busy", "error", "ok", "ok"]);
    expect(record.frames.map(({ segment }) => segment)).toEqual([0, 1, 1, 1, 2]);
    expect(record.frames.map(({ elapsedMs }) => elapsedMs)).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it.each(["mode", "type", "unit", "empty", "channel"] as const)(
    "stops after a confirmed %s change",
    async (change) => {
      const h = await setup();
      await h.service.start(h.request);
      const changed = snapshot();
      const input = changed.inputs[0]!;
      if (change === "mode") input.mode = 1;
      if (change === "type") input.type = 30;
      if (change === "unit") input.unit = "cm";
      if (change === "empty") input.state = "empty";
      if (change === "channel") input.values = [];
      h.emit({ snapshot: changed });
      const state = await h.service.stop();
      expect(state).toMatchObject({
        active: false,
        saved: true,
        recording: { reason: "source-changed", frameCount: 1 },
      });
    },
  );

  it("keeps initializing samples as gaps and ends on disconnect, never adopts another session", async () => {
    const h = await setup();
    await h.service.start(h.request);
    const initializing = snapshot();
    initializing.inputs[0]!.state = "initializing";
    initializing.inputs[0]!.mode = 1;
    h.emit({ snapshot: initializing });
    expect((await h.service.getState()).active).toBe(true);
    h.service.onDisconnect(h.sessionId);
    const state = await h.service.stop();
    expect(state.recording).toMatchObject({ reason: "disconnected", frameCount: 2 });
    h.emit();
    expect((await h.service.getState()).recording?.frameCount).toBe(2);
  });

  it("validates live sources and freshness before it creates a recording", async () => {
    const h = await setup();
    h.advance(SENSOR_LAB_LIMITS.freshMs + 1);
    await expect(h.service.start(h.request)).rejects.toThrow("fresh");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(await h.service.list()).toEqual([]);
    h.advance(0);
    h.request.channels[0]!.source.name = "Renderer supplied misleading label";
    const current = await h.service.start(h.request);
    expect(current.recording!.channels[0]!.source.name).toBe("Color");
    await h.service.stop();
    const changed = snapshot(10, 1);
    h.setLatest({ sessionId: h.sessionId, sequence: 2, status: "live", snapshot: changed });
    await expect(h.service.start(h.request)).rejects.toThrow("changed");
  });

  it("rejects extra, duplicate and forged sources and float32-invalid calibration parameters", async () => {
    const h = await setup();
    expect(
      sensorLabStartSchema.safeParse({
        ...h.request,
        channels: Array(5).fill(h.request.channels[0]),
      }).success,
    ).toBe(false);
    expect(
      sensorLabStartSchema.safeParse({
        ...h.request,
        channels: Array(2).fill(h.request.channels[0]),
      }).success,
    ).toBe(false);
    h.request.channels[0]!.source.port = 1;
    await expect(h.service.start(h.request)).rejects.toThrow("Invalid source identity");
    h.request.channels[0]!.source.port = 0;
    h.request.channels[0]!.calibration = {
      ...identityCalibration("%"),
      twoPoint: true,
      sourceA: 16_777_216,
      sourceB: 16_777_217,
    };
    await expect(h.service.start(h.request)).rejects.toThrow("sameSource");
  });

  it("uses monotonic duration even if the host clock moves, and stops at thirty minutes", async () => {
    const h = await setup();
    await h.service.start(h.request);
    h.adjustClock(-30_000);
    h.emit({}, 500);
    expect((await h.service.getState()).recording!.frames.at(-1)).toMatchObject({
      elapsedMs: 500,
      sampledAt: HOST_TIME - 29_500,
    });
    h.adjustClock(120_000);
    h.emit({}, SENSOR_LAB_LIMITS.durationMs);
    const state = await h.service.stop();
    expect(state.recording).toMatchObject({
      reason: "limit",
      durationMs: SENSOR_LAB_LIMITS.durationMs,
    });
  });

  it("enforces the 3,600-frame cap before any later replies can be appended", async () => {
    const h = await setup();
    await h.service.start(h.request);
    // This test exercises the recorder cap, independent of IPC snapshot copying costs.
    vi.spyOn(h.service as unknown as { publish(): void }, "publish").mockImplementation(() => {});
    for (let index = 1; index < 3610; index++) h.emit({}, index);
    const state = await h.service.stop();
    expect(state.recording).toMatchObject({ frameCount: 3600, reason: "limit" });
    expect(state.recording!.frames).toHaveLength(3600);
  });

  it("checkpoints every five seconds and recovers an interrupted recording without resuming", async () => {
    const h = await setup();
    vi.useFakeTimers();
    await h.service.start(h.request);
    h.emit({ snapshot: snapshot(18) }, 5200);
    vi.advanceTimersByTime(5000);
    // Read the completed atomic checkpoint after the queued save finishes.
    await h.store.flush();
    const recovered = new SensorLabStore(h.directory);
    const issues = await recovered.initialize();
    expect(issues).toHaveLength(1);
    expect((await recovered.list())[0]).toMatchObject({
      reason: "interrupted",
      frameCount: 2,
      durationMs: 5200,
    });
    await recovered.flush();
    expect((await recovered.read((await recovered.list())[0]!.id)).endedAt).toBe(HOST_TIME + 5200);
    expect((await h.service.suspend()).recording!.reason).toBe("suspend");
  });

  it("retains unsaved data, blocks close/update and retries after a disk failure", async () => {
    const h = await setup();
    await h.service.dispose();
    let fail = false;
    const store = new SensorLabStore(h.directory, async (target, content) => {
      if (fail) throw new Error("Disk full");
      await atomicSensorLabWrite(target, content);
    });
    const next = await setup({ directory: h.directory, store });
    await next.service.start(next.request);
    next.emit({ snapshot: snapshot(42.25) });
    fail = true;
    const stopped = await next.service.stop();
    expect(stopped).toMatchObject({ active: false, saved: false, error: "Disk full" });
    expect(stopped.recording!.frames[1]!.values).toEqual([42.25]);
    await expect(next.service.flush("update")).rejects.toThrow("Disk full");
    await expect(next.service.start(next.request)).rejects.toThrow("Save the pending");
    fail = false;
    expect(await next.service.retrySave()).toMatchObject({ saved: true, error: undefined });
    await expect(next.service.flush("close")).resolves.toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          path.join(h.directory, "recordings", `${stopped.recording!.id}.json`),
          "utf8",
        ),
      ).frames[1].values,
    ).toEqual([42.25]);
  });

  it("retains a failed initial recording and releases sampling until the save is retried", async () => {
    const h = await setup();
    await h.service.dispose();
    let fail = true;
    const store = new SensorLabStore(h.directory, async (target, content) => {
      if (fail) throw new Error("Disk unavailable");
      await atomicSensorLabWrite(target, content);
    });
    const next = await setup({ directory: h.directory, store });
    const state = await next.service.start(next.request);
    expect(state).toMatchObject({
      active: false,
      saved: false,
      recording: { reason: "interrupted" },
    });
    expect(next.release).toHaveBeenCalledOnce();
    fail = false;
    expect((await next.service.retrySave()).saved).toBe(true);
    expect((await store.list())[0]!.reason).toBe("interrupted");
  });

  it.each(["disconnected", "source-changed"] as const)(
    "does not become active if %s occurs during its first disk write",
    async (reason) => {
      const h = await setup();
      await h.service.dispose();
      let writeEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        writeEntered = resolve;
      });
      let releaseWrite!: () => void;
      const waiting = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const store = new SensorLabStore(h.directory, async (target, content) => {
        writeEntered();
        await waiting;
        await atomicSensorLabWrite(target, content);
      });
      const next = await setup({ directory: h.directory, store });
      const starting = next.service.start(next.request);
      await entered;
      if (reason === "disconnected") next.service.onDisconnect(next.sessionId);
      else next.emit({ snapshot: snapshot(12, 1) });
      releaseWrite();
      const state = await starting;
      expect(state).toMatchObject({ active: false, saved: true, recording: { reason } });
      expect(next.release).toHaveBeenCalledOnce();
    },
  );

  it("quarantines corrupt files and preserves valid recordings", async () => {
    const h = await setup();
    await h.service.start(h.request);
    const state = await h.service.stop();
    const corrupt = `${randomUUID()}.json`;
    await writeFile(path.join(h.directory, "recordings", corrupt), '{"schemaVersion":2');
    const store = new SensorLabStore(h.directory);
    expect(await store.initialize()).toHaveLength(1);
    expect((await store.list()).map(({ id }) => id)).toEqual([state.recording!.id]);
    expect(await readdir(path.join(h.directory, "corrupt"))).toHaveLength(1);
    await expect(store.read("../../outside")).rejects.toThrow();
  });

  it("refuses a fifty-first recording and never silently prunes history", async () => {
    const h = await setup();
    const store = new SensorLabStore(h.directory);
    const first = (await h.service.start(h.request)).recording!;
    await h.service.stop();
    await store.initialize();
    for (let index = 1; index < 50; index++)
      await store.save({ ...first, id: randomUUID(), endedAt: HOST_TIME, reason: "manual" });
    const next = await setup({ directory: h.directory });
    await expect(next.service.start(next.request)).rejects.toThrow("50-recording limit");
    expect(await next.service.list()).toHaveLength(50);
    await next.service.delete(first.id);
    expect((await next.service.start(next.request)).active).toBe(true);
  });

  it("persists independent calibration profiles, updates existing IDs and rejects client-created IDs", async () => {
    const h = await setup();
    const profile = await h.service.saveCalibration({ name: "Floor", ...h.request.channels[0]! });
    const reopened = new SensorLabStore(h.directory);
    expect(await reopened.listCalibrations()).toEqual([profile]);
    await expect(h.service.saveCalibration({ ...profile, id: randomUUID() })).rejects.toThrow(
      "no longer available",
    );
    expect(await h.service.saveCalibration({ ...profile, name: "Updated floor" })).toMatchObject({
      id: profile.id,
      name: "Updated floor",
    });
    await h.service.deleteCalibration(profile.id);
    expect(await h.service.listCalibrations()).toEqual([]);
  });

  it("keeps a failed calibration save retryable and blocks close until it is saved", async () => {
    const h = await setup();
    await h.service.dispose();
    let fail = true;
    const store = new SensorLabStore(h.directory, async (target, content) => {
      if (fail) throw new Error("Profile storage is full");
      await atomicSensorLabWrite(target, content);
    });
    const next = await setup({ directory: h.directory, store });
    await expect(
      next.service.saveCalibration({ name: "Floor", ...next.request.channels[0]! }),
    ).rejects.toThrow("storage is full");
    expect(await next.service.getState()).toMatchObject({
      saved: false,
      error: "Profile storage is full",
    });
    expect(await next.service.listCalibrations()).toHaveLength(1);
    await expect(next.service.flush()).rejects.toThrow("storage is full");
    fail = false;
    expect((await next.service.retrySave()).saved).toBe(true);
    expect(await new SensorLabStore(h.directory).listCalibrations()).toHaveLength(1);
  });
});
