import { expect, it, vi } from "vitest";
import { EV3DeviceSession } from "./session.js";
import type { DeviceIoBinding } from "./io-boundary.js";
it("F05/F14/F21 cancellation after one 900-byte chunk closes its original handle and sends no second chunk", async () => {
  const commands: number[] = [];
  let revoked = false;
  const signal = new AbortController().signal;
  const raw = new EV3DeviceSession(
    { id: "test", name: "EV3", transport: "mock" },
    {
      async exchange(payload, _signal, timeout) {
        commands.push(payload[1]!);
        if (payload[1] === 0x92) {
          expect(timeout).toBe(10000);
          return Uint8Array.of(3, 0x92, 0, 7);
        }
        if (payload[1] === 0x93) {
          expect(payload.length).toBe(903);
          revoked = true;
          return Uint8Array.of(3, 0x93, 0, 7);
        }
        expect(payload).toEqual(Uint8Array.of(1, 0x98, 7));
        return Uint8Array.of(3, 0x98, 0);
      },
      transmit: async () => {},
      close: async () => {},
    },
  );
  const binding: DeviceIoBinding = {
    step: "file-transfer",
    signal,
    boundary: {
      beforeExchange() {},
      afterExchange() {},
      timeoutMs: (step) => (step === "file-transfer" ? 10000 : 5000),
    },
    async exchange(payload, invoke) {
      if (revoked && payload[1] !== 0x98) throw new Error("authority-changed");
      return invoke(signal, 10000);
    },
  };
  await expect(
    raw.bindIo(binding).upload("/home/root/lms2012/prjs/a.rbf", new Uint8Array(1801), signal),
  ).rejects.toThrow("authority-changed");
  expect(commands).toEqual([0x92, 0x93, 0x98]);
});
it("F07 no work-cancellation signal aborts an already dispatched read", async () => {
  let reply!: (bytes: Uint8Array) => void;
  const work = new AbortController(),
    transport = new AbortController();
  const exchange = vi.fn((_payload: Uint8Array, signal: AbortSignal) => {
    expect(signal).toBe(transport.signal);
    return new Promise<Uint8Array>((resolve) => {
      reply = resolve;
    });
  });
  const raw = new EV3DeviceSession(
    { id: "test", name: "EV3", transport: "mock" },
    { exchange, transmit: async () => {}, close: async () => {} },
  );
  const view = raw.bindIo({
    step: "ordinary",
    signal: transport.signal,
    boundary: { beforeExchange() {}, afterExchange() {}, timeoutMs: () => 5000 },
    exchange: (_payload, invoke) => invoke(transport.signal, 5000),
  });
  const pending = view.stop(undefined, work.signal);
  work.abort();
  expect(transport.signal.aborted).toBe(false);
  reply(Uint8Array.of(2));
  await pending;
  expect(exchange).toHaveBeenCalledOnce();
});
