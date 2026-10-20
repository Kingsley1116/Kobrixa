import { expect, it, vi } from "vitest";
import { Sampler } from "./sampler.js";
import { frame, ID } from "./fake-provider.js";
it("F07 one in-flight poll serves monitor, battery and recording demand", async () => {
  let now = 0,
    release!: (value: ReturnType<typeof frame>) => void;
  const read = vi.fn(
    () =>
      new Promise<ReturnType<typeof frame>>((resolve) => {
        release = resolve;
      }),
  );
  const sampler = new Sampler({ sessionId: ID, now: () => now, read, busy: () => false });
  const a = sampler.fresh(),
    b = sampler.fresh();
  expect(read).toHaveBeenCalledTimes(1);
  release({ ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 });
  await Promise.all([a, b]);
  now = 2500;
  expect(sampler.snapshot().status).toBe("fresh");
  now = 2501;
  expect(sampler.snapshot().status).toBe("stale");
  sampler.dispose();
});
it("F07 battery-only waits 30 seconds after completion; busy never aborts a read", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ({ ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 }));
  let busy = false;
  const sampler = new Sampler({ sessionId: ID, now: () => Date.now(), read, busy: () => busy });
  sampler.demand("battery", 30000);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29999);
  expect(read).toHaveBeenCalledTimes(1);
  busy = true;
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(1);
  sampler.dispose();
  vi.useRealTimers();
});

it("provider frames have one receipt origin and mode snapshots use the same sequence", async () => {
  let now = 100;
  const raw = { ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 };
  const sampler = new Sampler({
    sessionId: ID,
    now: () => now,
    busy: () => false,
    read: async () => raw,
  });
  expect((await sampler.fresh()).frame).toMatchObject({ sequence: 1, elapsedMs: 0 });
  now = 150;
  expect(sampler.receive(raw).frame).toMatchObject({ sequence: 2, elapsedMs: 50 });
  expect(() => sampler.receive({ ...raw, sequence: 9 })).toThrow();
  sampler.dispose();
});

import { EventLedger } from "./registry.js";
import { pluginPrincipal } from "./fake-provider.js";
it("terminal telemetry and throwing consumers cannot break shared fresh reads", async () => {
  const owner = pluginPrincipal().owner,
    ledger = new EventLedger(
      () => 0,
      () => {},
      () => {},
    );
  const created = ledger.create(owner);
  if (!created.ok) throw new Error("create");
  const id = created.value.subscriptionId;
  ledger.publish(
    owner,
    id,
    { kind: "devices.catalog", data: { revision: 0, providers: [], sessions: [] } },
    "control",
  );
  ledger.closeAfterControl(owner, id);
  const sampler = new Sampler({
    sessionId: ID,
    now: () => 0,
    busy: () => false,
    read: async () => ({ ...frame(), sequence: 0, sampledAt: 0, elapsedMs: 0 }),
  });
  sampler.subscribe((sample) => {
    ledger.publish(
      owner,
      id,
      {
        kind: "devices.telemetry",
        data: { sessionId: ID, frames: [sample], snapshot: sampler.snapshot() },
      },
      "telemetry",
    );
  });
  const healthy = vi.fn();
  sampler.subscribe(healthy);
  await expect(sampler.fresh()).resolves.toMatchObject({ status: "fresh" });
  expect(healthy).toHaveBeenCalledTimes(1);
  sampler.dispose();
  ledger.dispose();
});
it.each(["busy", "read-error"] as const)("isolates listeners on %s frames", async (mode) => {
  const failure = new Error("read failed");
  const sampler = new Sampler({
    sessionId: ID,
    now: () => 0,
    busy: () => mode === "busy",
    read: async () => {
      throw failure;
    },
  });
  sampler.subscribe(() => {
    throw new Error("consumer failed");
  });
  const healthy = vi.fn();
  sampler.subscribe(healthy);
  const result = Promise.resolve().then(() => sampler.fresh());
  if (mode === "busy")
    await expect(result).rejects.toMatchObject({
      result: { error: { code: "PLUGIN_E_DEVICE_BUSY" } },
    });
  else await expect(result).rejects.toBe(failure);
  expect(healthy).toHaveBeenCalledTimes(1);
  sampler.dispose();
});
