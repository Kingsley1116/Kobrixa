import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import { MonitorService } from "./monitor-service.js";

const sample = (): DeviceMonitorSnapshot => ({
  sampledAt: Date.now(),
  battery: { percent: 70, voltage: 7.5 },
  program: { status: "stopped", rawStatus: 64, result: 0 },
  inputs: [],
  outputs: [],
});
const services: MonitorService[] = [];
function setup() {
  const devices = {
    monitor: vi.fn(async () => ({ status: "ok" as const, value: sample() })),
    inputModes: vi.fn(),
    setInputMode: vi.fn(),
  };
  const publish = vi.fn();
  const service = new MonitorService(devices, publish);
  services.push(service);
  return { devices, publish, service };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const service of services.splice(0)) void service.dispose();
  vi.useRealTimers();
});

describe("shared main-process monitor", () => {
  it("keeps one sampling clock when the panel closes during a recording", async () => {
    const { service, devices } = setup();
    await service.watch("ev3", true);
    await vi.advanceTimersByTimeAsync(0);
    await service.acquire("ev3");
    const before = devices.monitor.mock.calls.length;
    await service.watch("ev3", false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(devices.monitor).toHaveBeenCalledTimes(before + 3);
    await service.watch("ev3", true);
    await vi.advanceTimersByTimeAsync(0);
    const visible = devices.monitor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(devices.monitor).toHaveBeenCalledTimes(visible + 2);
    await service.watch("ev3", false);
    await service.release("ev3");
    const stopped = devices.monitor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(devices.monitor).toHaveBeenCalledTimes(stopped);
  });
  it("rejects mode changes during recording and never mutates the device", async () => {
    const { service, devices } = setup();
    await service.acquire("ev3");
    expect((await service.setInputMode("ev3", 0, 29, 1)).status).toBe("error");
    expect(devices.setInputMode).not.toHaveBeenCalled();
    expect(service.latest("ev3")?.recording).toBe(true);
    await service.release("ev3");
    expect(service.latest("ev3")?.recording).toBe(false);
  });
  it("drains a slow read and ignores its late result after disconnect", async () => {
    const { service, devices, publish } = setup();
    let finish!: (value: { status: "ok"; value: DeviceMonitorSnapshot }) => void;
    devices.monitor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await service.watch("old", true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(devices.monitor).toHaveBeenCalledTimes(1);
    const stopped = service.disconnect("old");
    finish({ status: "ok", value: sample() });
    await stopped;
    expect(publish.mock.calls.some(([value]) => value.status === "live")).toBe(false);
    expect(service.latest("old")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(devices.monitor).toHaveBeenCalledTimes(1);
  });
  it("cannot start from a cached sample while sensor metadata is changing", async () => {
    const { service, devices } = setup();
    await service.watch("ev3", true);
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (value: { status: "ok"; value: DeviceMonitorSnapshot }) => void;
    devices.setInputMode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const changing = service.setInputMode("ev3", 0, 29, 1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.acquire("ev3")).rejects.toThrow("mode operation");
    expect(service.recordingSession).toBeUndefined();
    finish({ status: "ok", value: sample() });
    await changing;
    await service.acquire("ev3");
    expect(service.recordingSession).toBe("ev3");
  });
  it("does not accept a busy result as the fresh first recording sample", async () => {
    const { service, devices } = setup();
    devices.monitor.mockResolvedValueOnce({ status: "busy" } as never);
    await expect(service.acquire("ev3")).rejects.toThrow("fresh");
    expect(service.recordingSession).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(devices.monitor).toHaveBeenCalledTimes(1);
  });
});
