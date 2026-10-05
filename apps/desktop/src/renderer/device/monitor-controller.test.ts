import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInputModes, DeviceMonitorSnapshot } from "@kobrixa/device";
import type { MonitorResult } from "../../shared/api.js";
import { MonitorController } from "./monitor-controller.js";
import { MonitorService } from "../../main/device/monitor-service.js";

const samplers: MonitorService[] = [];

function snapshot(
  status: DeviceMonitorSnapshot["program"]["status"] = "stopped",
): DeviceMonitorSnapshot {
  return {
    sampledAt: Date.now(),
    battery: { percent: 78, voltage: 7.5 },
    program: { status, rawStatus: status === "stopped" ? 0 : 1, result: 0 },
    inputs: [
      {
        port: 0,
        type: 29,
        connection: 122,
        mode: 0,
        state: "ready",
        name: "COL-REFLECT",
        modeName: "COL-REFLECT",
        unit: "pct",
        decimals: 0,
        values: [38],
        switchable: true,
      },
    ],
    outputs: [{ port: 0, type: 7, state: "ready", name: "Large motor", angle: -123 }],
  };
}
const modes: DeviceInputModes = {
  port: 0,
  type: 29,
  modes: [
    { mode: 0, name: "COL-REFLECT" },
    { mode: 1, name: "COL-AMBIENT" },
  ],
};
const ok = <T>(value: T): MonitorResult<T> => ({ status: "ok", value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const api = {
    monitor: vi.fn(async (_sessionId: string): Promise<MonitorResult<DeviceMonitorSnapshot>> =>
      ok(snapshot()),
    ),
    inputModes: vi.fn(
      async (
        _sessionId: string,
        _port: number,
        _type: number,
      ): Promise<MonitorResult<DeviceInputModes>> => ok(modes),
    ),
    setInputMode: vi.fn(
      async (
        _sessionId: string,
        _port: number,
        _type: number,
        mode: number,
      ): Promise<MonitorResult<DeviceMonitorSnapshot>> => {
        const value = snapshot();
        value.inputs[0]!.mode = mode;
        value.inputs[0]!.modeName = "COL-AMBIENT";
        return ok(value);
      },
    ),
  };
  const sampler = new MonitorService(api, () => {});
  samplers.push(sampler);
  const controller = new MonitorController({
    watchMonitor: (id, active) => sampler.watch(id, active),
    onMonitor: (listener) => sampler.subscribe(listener),
    inputModes: (id, port, type) => sampler.inputModes(id, port, type),
    setInputMode: (id, port, type, mode) => sampler.setInputMode(id, port, type, mode),
  });
  return { api, controller, sampler };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const sampler of samplers.splice(0)) void sampler.dispose();
  vi.useRealTimers();
});

describe("monitor sampling lifecycle", () => {
  it("samples only when active and waits 500 ms after the prior reply", async () => {
    const { api, controller } = setup();
    const pending = deferred<MonitorResult<DeviceMonitorSnapshot>>();
    api.monitor.mockReturnValueOnce(pending.promise);
    controller.configure("first", false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.monitor).not.toHaveBeenCalled();
    controller.configure("first", true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.monitor).toHaveBeenCalledTimes(1);
    pending.resolve(ok(snapshot()));
    await flush();
    await vi.advanceTimersByTimeAsync(499);
    expect(api.monitor).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.monitor).toHaveBeenCalledTimes(2);
    await controller.drain();
  });
  it("pauses without cancelling a request and discards its late result", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    const previous = controller.getSnapshot().snapshot;
    const pending = deferred<MonitorResult<DeviceMonitorSnapshot>>();
    api.monitor.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(500);
    controller.configure("first", false);
    pending.resolve(ok({ ...snapshot(), battery: { percent: 1, voltage: 1 } }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.getSnapshot().status).toBe("paused");
    expect(controller.getSnapshot().snapshot).toBe(previous);
    expect(api.monitor).toHaveBeenCalledTimes(2);
  });
  it("waits for an old session request before sampling the replacement and never publishes old data", async () => {
    const { api, controller } = setup();
    const pending = deferred<MonitorResult<DeviceMonitorSnapshot>>();
    api.monitor.mockReturnValueOnce(pending.promise);
    controller.configure("old", true);
    await flush();
    controller.configure("new", true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.monitor).toHaveBeenCalledTimes(1);
    pending.resolve(ok({ ...snapshot(), battery: { percent: 1, voltage: 1 } }));
    await flush();
    expect(controller.getSnapshot().snapshot?.battery.percent).toBe(78);
    expect(api.monitor).toHaveBeenLastCalledWith("new");
    expect(controller.getSnapshot().status).toBe("live");
    await controller.drain();
  });
  it("keeps the last values during busy and error replies, with stale status and no accumulated polls", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    const previous = controller.getSnapshot().snapshot;
    api.monitor.mockResolvedValueOnce({ status: "busy" });
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot()).toMatchObject({ status: "waiting", snapshot: previous });
    expect(controller.canSwitch(0)).toBe(false);
    api.monitor.mockResolvedValueOnce({
      status: "error",
      category: "timeout",
      message: "timed out",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      snapshot: previous,
      error: "timed out",
    });
    api.monitor.mockRejectedValueOnce(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().error).toBe("connection lost");
    expect(api.monitor).toHaveBeenCalledTimes(4);
    await controller.drain();
  });
  it("drains an in-flight sample and does not restart polling until explicitly activated", async () => {
    const { api, controller } = setup();
    const pending = deferred<MonitorResult<DeviceMonitorSnapshot>>();
    api.monitor.mockReturnValueOnce(pending.promise);
    controller.configure("first", true);
    await flush();
    let finished = false;
    const drain = controller.drain().then(() => {
      finished = true;
    });
    await flush();
    expect(finished).toBe(false);
    pending.resolve(ok(snapshot()));
    await drain;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.monitor).toHaveBeenCalledTimes(1);
    controller.configure("first", true);
    await flush();
    expect(api.monitor).toHaveBeenCalledTimes(2);
    await controller.drain();
  });
});

describe("monitor modes", () => {
  it.each(["running", "unknown"] as const)(
    "refuses mode queries and changes while the program is %s",
    async (status) => {
      const { api, controller } = setup();
      api.monitor.mockResolvedValue(ok(snapshot(status)));
      controller.configure("first", true);
      await flush();
      expect(controller.canSwitch(0)).toBe(false);
      await controller.loadModes(0);
      await controller.setMode(0, 1);
      expect(api.inputModes).not.toHaveBeenCalled();
      expect(api.setInputMode).not.toHaveBeenCalled();
      await controller.drain();
    },
  );
  it("allows mode recovery from invalid readings but requires ready metadata and a supported sensor", async () => {
    const { api, controller } = setup();
    const value = snapshot();
    value.inputs[0]!.values = [null];
    api.monitor.mockResolvedValue(ok(value));
    controller.configure("first", true);
    await flush();
    expect(controller.canSwitch(0)).toBe(true);
    value.inputs[0]!.state = "initializing";
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.canSwitch(0)).toBe(false);
    value.inputs[0]!.state = "ready";
    value.inputs[0]!.switchable = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.canSwitch(0)).toBe(false);
    await controller.drain();
  });
  it("loads modes lazily, shares the one-request limit with sampling, and caches per session/type", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    expect(api.inputModes).not.toHaveBeenCalled();
    const pending = deferred<MonitorResult<DeviceInputModes>>();
    api.inputModes.mockReturnValueOnce(pending.promise);
    const loading = controller.loadModes(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.inputModes).toHaveBeenCalledTimes(1);
    expect(api.monitor).toHaveBeenCalledTimes(1);
    expect(controller.canSwitch(0)).toBe(false);
    pending.resolve(ok(modes));
    await loading;
    await controller.loadModes(0);
    expect(api.inputModes).toHaveBeenCalledTimes(1);
    controller.configure("replacement", true);
    await flush();
    expect(controller.getSnapshot().modes).toEqual({});
    await controller.loadModes(0);
    expect(api.inputModes).toHaveBeenCalledTimes(2);
    await controller.drain();
  });
  it("rechecks the current sample after waiting for an in-flight poll before a mode operation", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    const pending = deferred<MonitorResult<DeviceMonitorSnapshot>>();
    api.monitor.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(500);
    const loading = controller.loadModes(0);
    await flush();
    expect(api.inputModes).not.toHaveBeenCalled();
    pending.resolve(ok(snapshot("running")));
    await loading;
    expect(api.inputModes).not.toHaveBeenCalled();
    expect(controller.getSnapshot().loadingPort).toBeUndefined();
    await controller.drain();
  });
  it("invalidates mode lists after hot-unplug and sensor replacement", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    await controller.loadModes(0);
    const absent = snapshot();
    absent.inputs[0]!.state = "empty";
    api.monitor.mockResolvedValueOnce(ok(absent));
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().modes).toEqual({});
    await vi.advanceTimersByTimeAsync(500);
    await controller.loadModes(0);
    const replacement = snapshot();
    replacement.inputs[0]!.type = 33;
    api.monitor.mockResolvedValueOnce(ok(replacement));
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().modes).toEqual({});
    await controller.drain();
  });
  it("changes only a listed mode, publishes confirmed readings, and never restores a mode on close", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    await controller.setMode(0, 1);
    expect(api.setInputMode).not.toHaveBeenCalled();
    await controller.loadModes(0);
    await controller.setMode(0, 99);
    expect(api.setInputMode).not.toHaveBeenCalled();
    await controller.setMode(0, 1);
    expect(api.setInputMode).toHaveBeenCalledWith("first", 0, 29, 1);
    expect(controller.getSnapshot().snapshot?.inputs[0]?.mode).toBe(1);
    await controller.drain();
    expect(api.setInputMode).toHaveBeenCalledTimes(1);
  });
  it("keeps errors from mode changes visible until the next attempt while refreshing actual state", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    await controller.loadModes(0);
    api.setInputMode.mockResolvedValueOnce({
      status: "error",
      category: "timeout",
      message: "Mode was not applied",
    });
    await controller.setMode(0, 1);
    expect(controller.getSnapshot()).toMatchObject({
      status: "waiting",
      modeError: "Mode was not applied",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().snapshot?.inputs[0]?.mode).toBe(0);
    expect(controller.getSnapshot().modeError).toBe("Mode was not applied");
    await controller.drain();
  });
  it("drains a mode query without publishing its late reply or scheduling another sample", async () => {
    const { api, controller } = setup();
    controller.configure("first", true);
    await flush();
    const pending = deferred<MonitorResult<DeviceInputModes>>();
    api.inputModes.mockReturnValueOnce(pending.promise);
    const loading = controller.loadModes(0);
    await flush();
    let finished = false;
    const drain = controller.drain().then(() => {
      finished = true;
    });
    await flush();
    expect(finished).toBe(false);
    pending.resolve(ok(modes));
    await Promise.all([drain, loading]);
    expect(controller.getSnapshot().modes).toEqual({});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.monitor).toHaveBeenCalledTimes(1);
  });
});
