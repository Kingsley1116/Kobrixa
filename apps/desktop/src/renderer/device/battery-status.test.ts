import { afterEach, expect, it, vi } from "vitest";
import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import type { MonitorUpdate } from "../../shared/sensor-lab.js";
import { BatteryStatus } from "./battery-status.js";
const snapshot = (percent: number): DeviceMonitorSnapshot => ({
  sampledAt: 0,
  battery: { percent, voltage: 7.5 },
  program: { status: "stopped", rawStatus: 0, result: 0 },
  inputs: [],
  outputs: [],
});
afterEach(() => vi.useRealTimers());
it("F07 battery consumes shared sampler events without a second clock", async () => {
  vi.useFakeTimers();
  let publish!: (update: MonitorUpdate) => void;
  const off = vi.fn();
  const battery = new BatteryStatus({
    onMonitor(listener) {
      publish = listener;
      return off;
    },
  });
  battery.setSession("session-one");
  const timers = vi.getTimerCount();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(vi.getTimerCount()).toBe(timers);
  expect(battery.getSnapshot().percent).toBeNull();
  publish({ sessionId: "session-one", sequence: 1, status: "live", snapshot: snapshot(15) });
  expect(battery.getSnapshot()).toMatchObject({ percent: 15, low: true });
  publish({ sessionId: "session-one", sequence: 0, status: "live", snapshot: snapshot(80) });
  expect(battery.getSnapshot().percent).toBe(15);
  battery.setSession("session-two");
  publish({ sessionId: "session-one", sequence: 2, status: "live", snapshot: snapshot(80) });
  expect(battery.getSnapshot().percent).toBeNull();
  publish({ sessionId: "session-two", sequence: 1, status: "live", snapshot: snapshot(80) });
  expect(battery.getSnapshot()).toMatchObject({ percent: 80, low: false });
  battery.dispose();
  expect(off).toHaveBeenCalledTimes(1);
  battery.observe(undefined, snapshot(80));
  expect(battery.getSnapshot().percent).toBeNull();
});
