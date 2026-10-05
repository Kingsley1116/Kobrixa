import { describe, expect, it, vi } from "vitest";
import { identityCalibration } from "../../shared/sensor-calibration.js";
import {
  channelKey,
  type CalibratedChannel,
  type SensorChannel,
  type SensorLabApi,
  type SensorLabState,
  type SensorRecording,
} from "../../shared/sensor-lab.js";
import type { MonitorState } from "./monitor-controller.js";
import { SensorLabController } from "./sensor-lab-controller.js";

function source(port = 0, channel = 0): SensorChannel {
  const value = {
    kind: "input" as const,
    port,
    type: 29,
    mode: 0,
    channel,
    name: "Color",
    modeName: "COL-REFLECT",
    unit: "%",
    decimals: 0,
  };
  return { ...value, id: channelKey(value) };
}
function recording(
  id: string,
  channels: CalibratedChannel[] = [{ source: source(), calibration: identityCalibration("%") }],
): SensorRecording {
  return {
    schemaVersion: 1,
    id,
    name: id,
    startedAt: 1000,
    durationMs: 0,
    frameCount: 0,
    device: { id: "brick", name: "EV3", transport: "usb" },
    channels,
    frames: [],
  };
}
function lab(record?: SensorRecording, active = false): SensorLabState {
  return { recording: record, active, waiting: false, saved: true, error: undefined, issues: [] };
}
function monitor(
  time = 1000,
  status: MonitorState["status"] = "live",
  sessionId = "session",
): MonitorState {
  return {
    sessionId,
    active: true,
    status,
    modes: {},
    loadingPort: undefined,
    switchingPort: undefined,
    error: undefined,
    modeError: undefined,
    snapshot: {
      sampledAt: time,
      battery: { percent: 90, voltage: 7 },
      program: { status: "stopped", rawStatus: 0, result: 0 },
      outputs: [],
      inputs: [{ ...source(), connection: 122, state: "ready", values: [42], switchable: true }],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function setup() {
  const listeners = new Set<(value: SensorLabState) => void>();
  let current = lab();
  const previous = recording("previous");
  const api: SensorLabApi = {
    getState: vi.fn(async () => current),
    start: vi.fn(async (request) => {
      current = lab(recording("new", request.channels), true);
      listeners.forEach((listener) => listener(current));
      return current;
    }),
    stop: vi.fn(async () => {
      current = lab({ ...current.recording!, endedAt: 5000, reason: "manual" }, false);
      listeners.forEach((listener) => listener(current));
      return current;
    }),
    retrySave: vi.fn(async () => current),
    list: vi.fn(async () => [previous]),
    read: vi.fn(async () => previous),
    delete: vi.fn(async () => {}),
    listCalibrations: vi.fn(async () => []),
    saveCalibration: vi.fn(async (profile) => ({ ...profile, id: "profile" })),
    deleteCalibration: vi.fn(async () => {}),
    exportCsv: vi.fn(async () => ({ cancelled: false })),
    onState: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  return {
    api,
    previous,
    controller: new SensorLabController(api),
    listeners,
    emit: (value: SensorLabState) => {
      current = value;
      listeners.forEach((listener) => listener(value));
    },
  };
}

describe("sensor lab renderer controller", () => {
  it("reinitializes after StrictMode cleanup and discards old async initialization", async () => {
    const h = setup();
    const pending = deferred<SensorLabState>();
    const oldList = deferred<SensorRecording[]>();
    vi.mocked(h.api.getState)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(lab(recording("fresh")));
    vi.mocked(h.api.list)
      .mockReturnValueOnce(oldList.promise)
      .mockResolvedValueOnce([recording("fresh")]);
    const oldInitialization = h.controller.initialize();
    expect(h.listeners.size).toBe(1);
    h.controller.dispose();
    expect(h.listeners.size).toBe(0);
    await h.controller.initialize();
    pending.resolve(lab(recording("stale")));
    oldList.resolve([recording("stale")]);
    await oldInitialization;
    expect(h.api.onState).toHaveBeenCalledTimes(2);
    expect(h.listeners.size).toBe(1);
    expect(h.controller.getSnapshot().current?.id).toBe("fresh");
    expect(h.controller.getSnapshot().history.map((item) => item.id)).toEqual(["fresh"]);
    h.emit(lab(recording("live"), true));
    expect(h.controller.getSnapshot().current?.id).toBe("live");
    h.controller.dispose();
  });
  it("does not overwrite a new event with the initial snapshot", async () => {
    const h = setup();
    const pending = deferred<SensorLabState>();
    vi.mocked(h.api.getState).mockReturnValueOnce(pending.promise);
    const initialization = h.controller.initialize();
    h.emit(lab(recording("newer"), true));
    pending.resolve(lab(recording("old")));
    await initialization;
    expect(h.controller.getSnapshot().current?.id).toBe("newer");
    h.controller.dispose();
  });
  it("bounds channel selection, samples only fresh timestamps and clears settings on brick change", async () => {
    const h = setup();
    await h.controller.initialize();
    h.controller.observeMonitor(monitor());
    for (let port = 0; port < 5; port++) h.controller.toggleChannel(source(port));
    expect(h.controller.getSnapshot().selected).toHaveLength(4);
    h.controller.observeMonitor(monitor());
    h.controller.observeMonitor(monitor());
    expect(h.controller.getSnapshot().preview).toHaveLength(1);
    h.controller.observeMonitor(monitor(1500, "waiting"));
    expect(h.controller.getSnapshot().preview).toHaveLength(1);
    h.controller.observeMonitor(monitor(2000));
    expect(h.controller.getSnapshot().preview.map((frame) => frame.values[0])).toEqual([42, 42]);
    expect(h.controller.getSnapshot().preview[1]!.segment).not.toBe(
      h.controller.getSnapshot().preview[0]!.segment,
    );
    h.controller.setCalibration(source().id, { ...identityCalibration("%"), zeroOffset: 20 });
    h.controller.observeMonitor(monitor(3000, "live", "another-brick"));
    expect(h.controller.getSnapshot().selected).toEqual([]);
    h.controller.dispose();
  });
  it("keeps the previous recording as comparison even if start emits before resolving", async () => {
    const h = setup();
    await h.controller.initialize();
    h.controller.observeMonitor(monitor());
    h.controller.toggleChannel(source());
    await h.controller.readRecording("previous");
    expect(await h.controller.start("session", "experiment")).toBe(true);
    expect(h.controller.getSnapshot().current?.id).toBe("new");
    expect(h.controller.getSnapshot().comparison?.id).toBe("previous");
    const selected = h.controller.getSnapshot().selected;
    h.controller.toggleChannel(source());
    h.controller.setCalibration(source().id, { ...identityCalibration("%"), zeroOffset: 20 });
    expect(h.controller.getSnapshot().selected).toBe(selected);
    expect(await h.controller.stop()).toBe(true);
    expect(h.controller.getSnapshot().lab.active).toBe(false);
    expect(h.api.list).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });
  it("shows a failed initial checkpoint and refreshes recovered profiles after retry", async () => {
    const h = setup();
    await h.controller.initialize();
    h.controller.toggleChannel(source());
    await h.controller.readRecording("previous");
    const failed = { ...lab(recording("unsaved")), saved: false, error: "Disk is full" };
    vi.mocked(h.api.start).mockResolvedValueOnce(failed);
    await h.controller.start("session", "experiment");
    expect(h.controller.getSnapshot().current?.id).toBe("unsaved");
    const profile = {
      id: "recovered-profile",
      name: "Zero",
      source: source(),
      calibration: identityCalibration("%"),
    };
    vi.mocked(h.api.retrySave).mockResolvedValueOnce({ ...failed, saved: true, error: undefined });
    vi.mocked(h.api.list).mockResolvedValueOnce([failed.recording!]);
    vi.mocked(h.api.listCalibrations).mockResolvedValueOnce([profile]);
    await h.controller.retrySave();
    expect(h.controller.getSnapshot().profiles).toEqual([profile]);
    expect(h.controller.getSnapshot().history[0]?.id).toBe("unsaved");
    expect(h.controller.getSnapshot().lab.saved).toBe(true);
    h.controller.dispose();
  });
  it("preserves viewed recordings after failed reads/deletes and reports export failures", async () => {
    const h = setup();
    await h.controller.initialize();
    await h.controller.readRecording("previous");
    vi.mocked(h.api.read).mockRejectedValueOnce(new Error("Cannot read recording"));
    expect(await h.controller.readRecording("broken")).toBe(false);
    expect(h.controller.getSnapshot().current?.id).toBe("previous");
    vi.mocked(h.api.delete).mockRejectedValueOnce(new Error("Cannot remove file"));
    expect(await h.controller.deleteRecording("previous")).toBe(false);
    expect(h.controller.getSnapshot().history).toHaveLength(1);
    vi.mocked(h.api.exportCsv).mockRejectedValueOnce(new Error("Disk is full"));
    expect(await h.controller.exportRecording("previous")).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({ error: "Disk is full", busy: false });
    h.controller.dispose();
  });
  it("preserves a loaded profile until explicitly applied and never applies incompatible profiles", async () => {
    const h = setup();
    await h.controller.initialize();
    h.controller.observeMonitor(monitor());
    h.controller.toggleChannel(source());
    const channel = {
      source: source(),
      calibration: { ...identityCalibration("%"), zeroOffset: 42 },
    };
    await h.controller.saveProfile("Zero", channel);
    expect(h.controller.getSnapshot().selected[0]?.calibration.zeroOffset).toBe(0);
    const profile = h.controller.getSnapshot().profiles[0]!;
    h.controller.applyProfile(profile, source(1).id);
    expect(h.controller.getSnapshot().selected[0]?.calibration.zeroOffset).toBe(0);
    h.controller.applyProfile(profile, source().id);
    expect(h.controller.getSnapshot().selected[0]?.calibration.zeroOffset).toBe(42);
    h.controller.dispose();
  });
});
