import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HidConnection } from "./usb.js";
import { frameMessage } from "./framing.js";
import { EV3DeviceSession } from "./session.js";

function setup() {
  const device = Object.assign(new EventEmitter(), {
    write: vi.fn((_data: number[]) => 0),
    close: vi.fn(),
  });
  const connection = new HidConnection(
    device as unknown as ConstructorParameters<typeof HidConnection>[0],
  );
  const session = new EV3DeviceSession({ id: "usb:a", name: "EV3", transport: "usb" }, connection);
  return { device, connection, session };
}
afterEach(() => vi.useRealTimers());

describe("continuous USB reader", () => {
  it("reports idle removal once and closes the handle", async () => {
    const h = setup();
    const lost = vi.fn();
    h.session.onDisconnect(lost);
    h.device.emit("error", new Error("device removed"));
    h.device.emit("error", new Error("late error"));
    expect(lost).toHaveBeenCalledOnce();
    expect(h.session.connected).toBe(false);
    await h.session.disconnect();
    expect(h.device.close).toHaveBeenCalledOnce();
    await expect(h.session.stop()).rejects.toThrow("disconnected");
  });

  it("receives replies even when they arrive synchronously during write", async () => {
    const h = setup();
    h.device.write.mockImplementation((frame) => {
      const counter = frame[3]! | (frame[4]! << 8);
      h.device.emit("data", frameMessage(counter, Uint8Array.of(2)));
      return frame.length;
    });
    const signal = new AbortController().signal;
    await expect(h.connection.exchange(Uint8Array.of(0), signal)).resolves.toEqual(
      Uint8Array.of(2),
    );
    await expect(h.connection.exchange(Uint8Array.of(0), signal)).resolves.toEqual(
      Uint8Array.of(2),
    );
    await h.session.disconnect();
  });

  it("rejects pending and queued exchanges on unplug without writing another request", async () => {
    const h = setup();
    const signal = new AbortController().signal;
    const first = h.connection.exchange(Uint8Array.of(0), signal);
    const second = h.connection.exchange(Uint8Array.of(0), signal);
    const results = Promise.allSettled([first, second]);
    await Promise.resolve();
    h.device.emit("error", new Error("removed"));
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(h.device.write).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "abort"])(
    "retires the handle after %s and ignores late replies",
    async (kind) => {
      vi.useFakeTimers();
      const h = setup();
      const controller = new AbortController();
      const request = h.connection.exchange(Uint8Array.of(0), controller.signal, 100);
      const rejected = expect(request).rejects.toMatchObject({
        category: kind === "timeout" ? "timeout" : "cancelled",
      });
      await Promise.resolve();
      if (kind === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(100);
      await rejected;
      h.device.emit("data", frameMessage(1, Uint8Array.of(2)));
      await expect(
        h.connection.exchange(Uint8Array.of(0), new AbortController().signal),
      ).rejects.toThrow();
      expect(h.device.write).toHaveBeenCalledOnce();
      expect(h.device.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("closes pending reads without announcing intentional disconnect as a loss", async () => {
    const h = setup();
    const lost = vi.fn();
    h.session.onDisconnect(lost);
    const request = h.connection.exchange(Uint8Array.of(0), new AbortController().signal);
    const rejected = expect(request).rejects.toThrow("closed");
    await Promise.resolve();
    await h.session.disconnect();
    await rejected;
    h.device.emit("error", new Error("late close callback"));
    expect(lost).not.toHaveBeenCalled();
  });

  it("reports failed no-reply writes as connection loss", async () => {
    const h = setup();
    h.device.write.mockImplementation(() => {
      throw new Error("could not write");
    });
    const lost = vi.fn();
    h.session.onDisconnect(lost);
    await expect(
      h.session.run("/robot/main.rbf", new AbortController().signal),
    ).rejects.toMatchObject({ category: "connection" });
    expect(lost).toHaveBeenCalledOnce();
  });
});
