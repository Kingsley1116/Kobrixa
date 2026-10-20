import { expect, it, vi } from "vitest";
import type { Ev3Connection } from "./contracts.js";
import { bindDeviceConnection, deviceIoStep } from "./io-boundary.js";
it.each([
  ["motor", 2000],
  ["ordinary", 5000],
  ["file-transfer", 10000],
] as const)("F21 %s clamps each exchange to %i and remaining budget", async (step, maximum) => {
  let remaining = 12000;
  const exchange = vi.fn(async (_bytes: Uint8Array, _signal: AbortSignal, timeout?: number) => {
    expect(timeout).toBe(Math.min(maximum, remaining));
    return Uint8Array.of(2);
  });
  const raw: Ev3Connection = {
    exchange,
    transmit: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const before = vi.fn(),
    after = vi.fn();
  const bound = bindDeviceConnection(raw, {
    step,
    signal: new AbortController().signal,
    boundary: {
      beforeExchange: before,
      afterExchange: after,
      timeoutMs: () => Math.min(maximum, remaining),
    },
    exchange: async (_payload, invoke) => invoke(new AbortController().signal, remaining),
  });
  await bound.exchange(Uint8Array.of(0), new AbortController().signal, 20000);
  remaining = 17;
  await bound.exchange(Uint8Array.of(0), new AbortController().signal, 20000);
  expect(before).toHaveBeenCalledTimes(2);
  expect(after).toHaveBeenCalledTimes(2);
});
it("F05 every upload/list/download system packet is file-transfer; close remains ordinary cleanup", () => {
  for (const op of [0x92, 0x93, 0x94, 0x95, 0x99, 0x9a])
    expect(deviceIoStep(Uint8Array.of(1, op), "ordinary")).toBe("file-transfer");
  expect(deviceIoStep(Uint8Array.of(1, 0x98), "ordinary")).toBe("ordinary");
});
it("F09 before-send rejection dispatches nothing and never retries transmit", async () => {
  const transmit = vi.fn(async () => {});
  const bound = bindDeviceConnection(
    { exchange: async () => new Uint8Array(), transmit, close: async () => {} },
    {
      step: "ordinary",
      signal: new AbortController().signal,
      boundary: {
        beforeExchange() {
          throw new Error("revoked");
        },
        afterExchange() {},
        timeoutMs: () => 5000,
      },
      exchange: async (_payload, invoke) => invoke(new AbortController().signal, 5000),
    },
  );
  await expect(bound.transmit(Uint8Array.of(0x80), new AbortController().signal)).rejects.toThrow(
    "revoked",
  );
  expect(transmit).not.toHaveBeenCalled();
});
it("F21 an expired work budget cannot suppress original-operation file-close", async () => {
  const exchange = vi.fn(async (_bytes: Uint8Array, _signal: AbortSignal, timeout?: number) => {
    expect(timeout).toBe(37);
    return Uint8Array.of(3, 0x98, 0);
  });
  const bound = bindDeviceConnection(
    { exchange, transmit: async () => {}, close: async () => {} },
    {
      step: "file-transfer",
      signal: new AbortController().signal,
      boundary: { beforeExchange() {}, afterExchange() {}, timeoutMs: () => 0 },
      exchange: async (payload, invoke) => {
        expect(payload[1]).toBe(0x98);
        return invoke(new AbortController().signal, 37);
      },
    },
  );
  await bound.exchange(Uint8Array.of(1, 0x98, 7), new AbortController().signal);
  expect(exchange).toHaveBeenCalledOnce();
});
