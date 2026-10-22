import type * as Net from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof Net>();
  return { ...actual, default: { ...actual, createConnection: mock.createConnection } };
});
import { WiFiTransport } from "./wifi.js";
class Socket extends EventEmitter {
  destroyed = false;
  write = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
}
let socket: Socket;
const target = { id: "wifi", name: "EV3", transport: "wifi" as const, address: "192.168.0.42" };
beforeEach(() => {
  vi.useFakeTimers();
  socket = new Socket();
  mock.createConnection.mockReturnValue(socket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const settle = () => vi.advanceTimersByTimeAsync(0);
it("times out TCP connection and destroys the pending socket", async () => {
  const pending = new WiFiTransport().connect(target, new AbortController().signal, {
    connectTimeoutMs: 10000,
  });
  const rejected = expect(pending).rejects.toMatchObject({ category: "timeout" });
  await vi.advanceTimersByTimeAsync(9999);
  expect(socket.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(socket.destroy).toHaveBeenCalledOnce();
  expect(socket.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["timeout", "abort", "error", "close"])("cleans up the handshake on %s", async (kind) => {
  const controller = new AbortController();
  const pending = new WiFiTransport().connect(target, controller.signal, {
    handshakeTimeoutMs: 1000,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    category: kind === "timeout" ? "timeout" : kind === "abort" ? "cancelled" : "connection",
  });
  socket.emit("connect");
  await settle();
  expect(socket.write).toHaveBeenCalledOnce();
  if (kind === "timeout") await vi.advanceTimersByTimeAsync(1000);
  else if (kind === "abort") controller.abort();
  else if (kind === "error") socket.emit("error", new Error("disconnected"));
  else socket.emit("close");
  await rejected;
  expect(socket.destroy).toHaveBeenCalledOnce();
  expect(socket.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("honors cancellation before and during TCP connection", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(new WiFiTransport().connect(target, controller.signal)).rejects.toMatchObject({
    category: "cancelled",
  });
  expect(mock.createConnection).not.toHaveBeenCalled();
  const active = new AbortController();
  const pending = new WiFiTransport().connect(target, active.signal);
  const rejected = expect(pending).rejects.toMatchObject({ category: "cancelled" });
  active.abort();
  await rejected;
  expect(socket.destroyed).toBe(true);
  expect(socket.eventNames()).toEqual([]);
});
it("retains the accepted socket and removes handshake timers/listeners", async () => {
  const pending = new WiFiTransport().connect(target, new AbortController().signal);
  socket.emit("connect");
  await settle();
  socket.emit("data", Buffer.from("Accept:EV340"));
  expect((await pending).connected).toBe(true);
  expect(socket.destroy).not.toHaveBeenCalled();
  expect(socket.listenerCount("error")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
  expect(socket.listenerCount("data")).toBe(1); // Framed connection owns its new listener.
  expect(vi.getTimerCount()).toBe(0);
});

import { bindDeviceConnection as bindStage3 } from "./io-boundary.js";
import { it as stage3It, expect as stage3Expect } from "vitest";
stage3It(
  "F21 bound connection never forwards an ordinary cancellation to the transport",
  async () => {
    const work = new AbortController(),
      transport = new AbortController();
    let received: AbortSignal | undefined;
    const bound = bindStage3(
      {
        exchange: async (_bytes, signal) => {
          received = signal;
          return Uint8Array.of(2);
        },
        transmit: async () => {},
        close: async () => {},
      },
      {
        step: "ordinary",
        signal: transport.signal,
        boundary: { beforeExchange() {}, afterExchange() {}, timeoutMs: () => 5000 },
        exchange: (_payload, invoke) => invoke(transport.signal, 5000),
      },
    );
    work.abort();
    await bound.exchange(Uint8Array.of(0), work.signal);
    stage3Expect(received).toBe(transport.signal);
    stage3Expect(received?.aborted).toBe(false);
  },
);

it.each(["brick.local", "fe80::1%en0", "999.1.1.1"])(
  "F02 rejects unbound endpoint %s before socket creation",
  async (address) => {
    await expect(
      new WiFiTransport().connect({ ...target, address }, new AbortController().signal),
    ).rejects.toThrow("literal");
    expect(mock.createConnection).not.toHaveBeenCalled();
  },
);
