import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BatteryStatus } from "./battery-status.js";

const snapshot = (percent: number | null, voltage = 7.5): DeviceMonitorSnapshot => ({
  sampledAt: 0,
  battery: { percent, voltage },
  program: { status: "stopped", rawStatus: 0, result: 0 },
  inputs: [],
  outputs: [],
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("polls while connected, keeps readings when busy and flags low battery", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ status: "ok", value: snapshot(80) })
    .mockResolvedValueOnce({ status: "busy" })
    .mockResolvedValueOnce({ status: "ok", value: snapshot(12) });
  const battery = new BatteryStatus(read, 1000);
  battery.setSession("s1");
  await vi.advanceTimersByTimeAsync(0);
  expect(battery.getSnapshot()).toMatchObject({ sessionId: "s1", percent: 80, low: false });
  await vi.advanceTimersByTimeAsync(1000);
  expect(battery.getSnapshot().percent).toBe(80);
  await vi.advanceTimersByTimeAsync(1000);
  expect(battery.getSnapshot()).toMatchObject({ percent: 12, low: true });
  battery.setSession(undefined);
  expect(battery.getSnapshot()).toMatchObject({ sessionId: undefined, percent: null });
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(3);
});

it("ignores stale reads and monitor samples from another session", async () => {
  let resolve!: (value: unknown) => void;
  const read = vi.fn().mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const battery = new BatteryStatus(read, 60_000);
  battery.setSession("old");
  battery.setSession(undefined);
  resolve({ status: "ok", value: snapshot(50) });
  await vi.advanceTimersByTimeAsync(0);
  expect(battery.getSnapshot().percent).toBeNull();
  read.mockResolvedValue({ status: "busy" });
  battery.setSession("s2");
  battery.observe("other", snapshot(40));
  expect(battery.getSnapshot().percent).toBeNull();
  battery.observe("s2", snapshot(40));
  expect(battery.getSnapshot().percent).toBe(40);
  battery.dispose();
});
