import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import type { MonitorResult } from "../../shared/api.js";
import { identityCalibration } from "../../shared/sensor-calibration.js";
import { monitorChannels, type SensorLabStartRequest } from "../../shared/sensor-lab.js";
import { MonitorService } from "../device/monitor-service.js";
import { SensorLabService } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function snapshot(mode = 0): DeviceMonitorSnapshot {
  return {
    sampledAt: Date.now(),
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
        modeName: mode === 0 ? "COL-REFLECT" : "COL-AMBIENT",
        unit: "%",
        decimals: 1,
        values: [12.5],
        switchable: true,
      },
    ],
    outputs: [],
  };
}

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kobrixa-sensor-integration-"));
  const sessionId = randomUUID();
  const devices = {
    monitor: vi.fn(async (_session: string): Promise<MonitorResult<DeviceMonitorSnapshot>> => ({
      status: "ok",
      value: snapshot(),
    })),
    inputModes: vi.fn(async () => ({
      status: "ok" as const,
      value: { port: 0, type: 29, modes: [{ mode: 0, name: "COL-REFLECT" }] },
    })),
    setInputMode: vi.fn(async () => ({ status: "ok" as const, value: snapshot(1) })),
  };
  const monitor = new MonitorService(devices, () => {});
  const lab = new SensorLabService({
    directory,
    device: () => ({ id: "test", name: "EV3", transport: "usb" }),
    acquire: (id) => monitor.acquire(id),
    release: (id) => monitor.release(id),
    latest: monitor.latest,
    publish: () => {},
    monotonic: () => Date.now(),
  });
  const unsubscribe = monitor.subscribe((update) => lab.observe(update));
  cleanups.push(async () => {
    await lab.dispose();
    unsubscribe();
    await monitor.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const source = monitorChannels(snapshot())[0]!;
  const request: SensorLabStartRequest = {
    sessionId,
    name: "Shared stream",
    channels: [{ source, calibration: identityCalibration(source.unit) }],
  };
  return { monitor, lab, devices, request, sessionId };
}

describe("shared monitor and sensor lab integration", () => {
  it("keeps exactly one timer while recording survives hiding the monitor panel", async () => {
    vi.useFakeTimers({ now: 1_780_000_000_000 });
    const h = await setup();
    await h.monitor.watch(h.sessionId, true);
    await h.lab.start(h.request);
    expect(h.devices.monitor).toHaveBeenCalledTimes(2);
    await h.monitor.watch(h.sessionId, true);
    // A repeated visible subscription may refresh immediately, but cannot add another loop.
    await Promise.resolve();
    await Promise.resolve();
    await h.monitor.watch(h.sessionId, false);
    const readsBefore = h.devices.monitor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.devices.monitor).toHaveBeenCalledTimes(readsBefore + 3);
    const state = await h.lab.getState();
    expect(state.active).toBe(true);
    expect(state.recording!.frames.at(-1)!.elapsedMs).toBe(1500);
    await h.lab.stop();
    const readsAfter = h.devices.monitor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.devices.monitor).toHaveBeenCalledTimes(readsAfter);
  });

  it("does not start from a stale cached value when a foreground operation owns the device", async () => {
    vi.useFakeTimers({ now: 1_780_000_000_000 });
    const h = await setup();
    await h.monitor.watch(h.sessionId, true);
    await Promise.resolve();
    await Promise.resolve();
    h.devices.monitor.mockResolvedValueOnce({ status: "busy" });
    await expect(h.lab.start(h.request)).rejects.toThrow("fresh");
    expect((await h.lab.getState()).active).toBe(false);
    expect(await h.lab.list()).toEqual([]);
    expect(h.monitor.recordingSession).toBeUndefined();
  });

  it("waits for an in-flight sample before finishing stop without appending its late response", async () => {
    vi.useFakeTimers({ now: 1_780_000_000_000 });
    const h = await setup();
    await h.lab.start(h.request);
    let resolve!: (value: MonitorResult<DeviceMonitorSnapshot>) => void;
    h.devices.monitor.mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(h.monitor.busy).toBe(true);
    let finished = false;
    const stopping = h.lab.stop().then((state) => {
      finished = true;
      return state;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    resolve({ status: "ok", value: snapshot() });
    const state = await stopping;
    expect(state).toMatchObject({
      active: false,
      saved: true,
      recording: { frameCount: 1, reason: "manual" },
    });
    expect(h.monitor.busy).toBe(false);
  });

  it("auto-stops a changed source from inside the sampler callback without deadlock", async () => {
    vi.useFakeTimers({ now: 1_780_000_000_000 });
    const h = await setup();
    await h.lab.start(h.request);
    h.devices.monitor.mockImplementationOnce(async () => ({ status: "ok", value: snapshot(1) }));
    await vi.advanceTimersByTimeAsync(500);
    const state = await h.lab.stop();
    expect(state).toMatchObject({
      active: false,
      saved: true,
      recording: { reason: "source-changed" },
    });
    expect(h.monitor.recordingSession).toBeUndefined();
  });

  it("records foreground contention as a gap and forbids changing modes until recording stops", async () => {
    vi.useFakeTimers({ now: 1_780_000_000_000 });
    const h = await setup();
    await h.lab.start(h.request);
    expect(await h.monitor.setInputMode(h.sessionId, 0, 29, 1)).toMatchObject({ status: "error" });
    expect(h.devices.setInputMode).not.toHaveBeenCalled();
    h.devices.monitor.mockResolvedValueOnce({ status: "busy" });
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    const state = await h.lab.stop();
    expect(state.recording!.frames.map(({ values }) => values)).toEqual([[12.5], [null], [12.5]]);
    expect(state.recording!.frames.map(({ segment }) => segment)).toEqual([0, 1, 2]);
  });
});
