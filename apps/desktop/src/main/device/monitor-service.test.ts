import { expect, it, vi } from "vitest";
import { MonitorService } from "./monitor-service.js";
import type { LegacyDevice } from "../device-broker/legacy-device.js";
it("F07 separate owners share broker demand and hiding one owner preserves the other", async () => {
  const remove = vi.fn(async () => {}),
    watch = vi.fn(async () => remove);
  const service = new MonitorService(
    { watch, inputModes: vi.fn(), setInputMode: vi.fn() } as unknown as LegacyDevice,
    () => {},
  );
  await service.watch("s", true, 1);
  await service.watch("s", true, 2);
  expect(watch).toHaveBeenCalledTimes(2);
  await service.watch("s", false, 1);
  expect(remove).toHaveBeenCalledOnce();
  await service.watch("s", false, 2);
  expect(remove).toHaveBeenCalledTimes(2);
  await service.dispose();
  expect(remove).toHaveBeenCalledTimes(2);
});
it("F07 close during subscription registration disposes a late subscription", async () => {
  let resolve!: (dispose: () => Promise<void>) => void;
  const remove = vi.fn(async () => {});
  const service = new MonitorService(
    {
      watch: () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    } as unknown as LegacyDevice,
    () => {},
  );
  const opening = service.watch("s", true, 1);
  const closing = service.dispose();
  resolve(remove);
  await opening;
  await closing;
  expect(remove).toHaveBeenCalledOnce();
});
it("T5fix a closed feed pauses Monitor and allows the same owner to watch again", async () => {
  let closed: ((reason: string) => void) | undefined;
  const watch = vi.fn(
    async (_id: string, _interval: number, _receive: unknown, onClosed?: typeof closed) => {
      closed = onClosed;
      return async () => {};
    },
  );
  const publish = vi.fn();
  const service = new MonitorService({ watch } as unknown as LegacyDevice, publish);
  await service.watch("s", true, 1);
  closed?.("overflow");
  expect(service.latest("s")?.status).toBe("paused");
  await service.watch("s", true, 1);
  expect(watch).toHaveBeenCalledTimes(2);
  await service.dispose();
});
