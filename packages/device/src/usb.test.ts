import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HidConnection, trimHidReply } from "./usb.js";
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

  it("reports failed program control writes as connection loss", async () => {
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

describe("USB reply framing", () => {
  it.each([255, 256, 257, 512, 768])(
    "preserves a %i-byte declared frame with or without a report ID",
    (length) => {
      const payload = new Uint8Array(length - 2);
      payload[0] = 2;
      const frame = frameMessage(42, payload);
      for (const prefix of [false, true]) {
        const report = new Uint8Array(1024 + Number(prefix));
        report.set(frame, Number(prefix));
        expect(trimHidReply(report, 42)).toEqual(frame);
        expect(trimHidReply(report)).toEqual(frame);
      }
    },
  );

  it("uses the counter to disambiguate plausible prefixed and unprefixed headers", () => {
    // Both offsets have a valid length and direct reply type.
    const report = new Uint8Array(1025);
    report.set([0, 3, 3, 1, 2, 2]);
    expect(() => trimHidReply(report)).toThrow("Ambiguous");
    expect(trimHidReply(report, 0x0103)).toEqual(report.slice(0, 770));
    expect(trimHidReply(report, 0x0201)).toEqual(report.slice(1, 774));
  });

  it("rejects a report even when both layouts match the counter", () => {
    const report = new Uint8Array(1025);
    report.set([0, 3, 3, 3, 3, 2]);
    expect(() => trimHidReply(report, 0x0303)).toThrow("Ambiguous");
  });

  it.each([
    Uint8Array.of(0, 0),
    Uint8Array.of(3, 0, 1, 0, 0),
    Uint8Array.of(20, 0, 1, 0, 2),
    Uint8Array.of(3, 0, 1, 0, 3),
    frameMessage(2, Uint8Array.of(2)),
  ])("rejects malformed, truncated and mismatched replies", (report) => {
    expect(() => trimHidReply(report, 1)).toThrow("Malformed or mismatched");
  });

  it("retires the HID handle on invalid input without throwing from the data callback", async () => {
    const h = setup();
    const lost = vi.fn();
    h.session.onDisconnect(lost);
    const pending = h.connection.exchange(Uint8Array.of(0), new AbortController().signal);
    const rejected = expect(pending).rejects.toMatchObject({ category: "protocol" });
    await Promise.resolve();
    expect(() => h.device.emit("data", frameMessage(99, Uint8Array.of(2)))).not.toThrow();
    await rejected;
    expect(lost).toHaveBeenCalledOnce();
    expect(h.device.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "receives boundary replies through the HID reader (report ID: %s)",
    async (prefix) => {
      const h = setup();
      const payload = new Uint8Array(254);
      payload[0] = 2;
      h.device.write.mockImplementation((frame) => {
        const counter = frame[3]! | (frame[4]! << 8);
        const report = new Uint8Array(1024 + Number(prefix));
        report.set(frameMessage(counter, payload), Number(prefix));
        h.device.emit("data", report);
        return frame.length;
      });
      await expect(
        h.connection.exchange(Uint8Array.of(0), new AbortController().signal),
      ).resolves.toEqual(payload);
      await h.session.disconnect();
    },
  );
});
