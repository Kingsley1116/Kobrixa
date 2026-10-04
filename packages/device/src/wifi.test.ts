import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("node:net", () => ({ default: { createConnection: mock.createConnection } }));
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
