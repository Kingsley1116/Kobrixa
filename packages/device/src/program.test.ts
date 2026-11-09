import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceOperationError } from "./errors.js";
import { MockConnection } from "./mock.js";
import { EV3DeviceSession } from "./session.js";

type Parameter = number | string | { offset: number };

// Interpret firmware instructions, rather than matching production packet bytes.
class Firmware {
  status = 64;
  result = 0;
  debugStatus = 64;
  imageSize = 128;
  imagePointer = 0x90000000;
  stopAccepted = true;
  validImage = true;
  startAccepted = true;
  finishBeforeReply = false;
  requests: Uint8Array[] = [];
  actions: string[] = [];
  beforeCommand: (() => void) | undefined;

  respond = (payload: Uint8Array): Uint8Array => {
    this.requests.push(payload);
    this.beforeCommand?.();
    expect(payload[0]).toBe(0); // Every stage requests a reply.
    const globals = payload[1]! | ((payload[2]! & 3) << 8);
    const reply = new Uint8Array(globals + 1);
    reply[0] = 2;
    const ram = new DataView(reply.buffer, 1);
    const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let ip = 3;
    const parameter = (): Parameter => {
      const tag = code.getUint8(ip++);
      if (tag === 0x84) {
        const start = ip;
        while (code.getUint8(ip++)) {
          /* zero-terminated string */
        }
        return new TextDecoder().decode(payload.subarray(start, ip - 1));
      }
      if (!(tag & 0x80)) return tag & 0x40 ? { offset: tag & 31 } : tag & 0x20 ? tag - 64 : tag;
      const width = [0, 1, 2, 4][tag & 3]!;
      if (!width) throw new Error("Invalid parameter");
      const value =
        width === 1
          ? code.getInt8(ip)
          : width === 2
            ? code.getInt16(ip, true)
            : code.getInt32(ip, true);
      ip += width;
      return value;
    };
    const read = (width = 1): number => {
      const p = parameter();
      if (typeof p === "string") throw new Error("Unexpected string operand");
      return typeof p === "number"
        ? p
        : width === 4
          ? ram.getInt32(p.offset, true)
          : ram.getInt8(p.offset);
    };
    const write = (value: number, width = 1): void => {
      const p = parameter();
      if (typeof p !== "object") throw new Error("Expected a global operand");
      if (width === 4) ram.setInt32(p.offset, value, true);
      else ram.setUint8(p.offset, value);
    };
    while (ip < payload.length) {
      const opcode = code.getUint8(ip++);
      if (opcode === 0x02) {
        expect(read()).toBe(1);
        this.actions.push("stop");
        if (this.stopAccepted) {
          this.status = 64;
          this.result = 0;
        }
      } else if (opcode === 0x0c) {
        const command = read(),
          slot = read();
        expect([1, 4]).toContain(slot);
        if (command === 22) write(slot === 1 ? this.status : this.debugStatus);
        else if (command === 24) write(this.result);
        else throw new Error("Unexpected program info command");
      } else if ([0x70, 0x76, 0x6e].includes(opcode)) {
        const width = opcode === 0x70 ? 1 : 4;
        const left = read(width),
          right = read(width),
          distance = read(4);
        if (opcode === 0x70 ? left !== right : opcode === 0x76 ? left <= right : left === right)
          ip += distance;
      } else if (opcode === 0xc0) {
        expect(read()).toBe(8);
        expect(read()).toBe(1);
        const path = parameter();
        expect(typeof path).toBe("string");
        this.actions.push("load:" + path);
        write(this.status === 64 ? this.imageSize : 0, 4);
        write(this.status === 64 ? this.imagePointer : 0, 4);
      } else if (opcode === 0x03) {
        expect(read()).toBe(1);
        expect(read(4)).toBe(this.imageSize);
        expect(read(4) >>> 0).toBe(this.imagePointer >>> 0);
        expect(read()).toBe(0);
        this.actions.push("start");
        if (this.status === 64 && this.debugStatus === 64 && this.startAccepted) {
          this.status = this.validImage ? 16 : 64;
          this.result = this.validImage ? 1 : 2;
        }
      } else throw new Error("Unexpected opcode: " + opcode);
    }
    expect(ip).toBe(payload.length);
    if (this.finishBeforeReply && this.status === 16) {
      this.status = 64;
      this.result = 0;
    }
    return reply;
  };
}

function setup() {
  const firmware = new Firmware();
  const connection = new MockConnection(firmware.respond);
  const session = new EV3DeviceSession({ id: "test", name: "EV3", transport: "mock" }, connection);
  return { firmware, connection, session, signal: new AbortController().signal };
}
const target = "/home/root/lms2012/prjs/demo/main.rbf";
afterEach(() => vi.useRealTimers());

describe("confirmed program execution", () => {
  it.each([16, 64])(
    "stops a user slot with status %s, loads and confirms the new program",
    async (status) => {
      const h = setup();
      h.firmware.status = status;
      await h.session.run(target, h.signal);
      expect(h.firmware.actions).toEqual(["stop", "load:" + target, "start"]);
      expect(h.firmware.status).toBe(16);
      expect(h.firmware.requests).toHaveLength(2);
    },
  );

  it("accepts a short program that finishes before its startup reply arrives", async () => {
    const h = setup();
    h.firmware.finishBeforeReply = true;
    await expect(h.session.run(target, h.signal)).resolves.toBeUndefined();
    expect(h.firmware.status).toBe(64);
    expect(h.firmware.result).toBe(0);
    expect(h.firmware.requests).toHaveLength(2);
  });

  it("does not mistake the old program's STOPPED/OK result for a new start", async () => {
    const h = setup();
    h.firmware.startAccepted = false;
    await expect(h.session.run(target, h.signal)).rejects.toThrow(
      "did not confirm program startup",
    );
  });

  it("does not load when stopping was not confirmed", async () => {
    const h = setup();
    h.firmware.status = 16;
    h.firmware.stopAccepted = false;
    await expect(h.session.run(target, h.signal)).rejects.toThrow("previous program stopped");
    expect(h.firmware.actions).toEqual(["stop"]);
  });

  it.each(["user", "debug"])("guards against an occupied %s slot before loading", async (slot) => {
    const h = setup();
    h.firmware.beforeCommand = () => {
      if (h.firmware.requests.length === 2) {
        if (slot === "user") h.firmware.status = 16;
        else h.firmware.debugStatus = 16;
      }
    };
    await expect(h.session.run(target, h.signal)).rejects.toThrow("slot is busy");
    expect(h.firmware.actions).toEqual(["stop"]);
  });

  it.each([
    [0, 100],
    [-1, 100],
    [100, 0],
  ])("never starts an unloaded image (%s, %s)", async (size, pointer) => {
    const h = setup();
    h.firmware.imageSize = size;
    h.firmware.imagePointer = pointer;
    await expect(h.session.run(target, h.signal)).rejects.toThrow("could not load");
    expect(h.firmware.actions).toEqual(["stop", "load:" + target]);
  });

  it("reports firmware rejection of an invalid image", async () => {
    const h = setup();
    h.firmware.validImage = false;
    await expect(h.session.run(target, h.signal)).rejects.toThrow("status 64, result 2");
  });

  it.each([Uint8Array.of(4), Uint8Array.of(2), Uint8Array.of(3, 64)])(
    "rejects malformed or error stop acknowledgements",
    async (reply) => {
      const h = setup();
      vi.spyOn(h.connection, "exchange").mockResolvedValueOnce(reply);
      await expect(h.session.run(target, h.signal)).rejects.toThrow();
      expect(h.firmware.actions).toEqual([]);
    },
  );

  it("rejects a truncated startup acknowledgement", async () => {
    const h = setup();
    vi.spyOn(h.connection, "exchange")
      .mockImplementationOnce(async (payload) => h.firmware.respond(payload))
      .mockResolvedValueOnce(Uint8Array.of(2));
    await expect(h.session.run(target, h.signal)).rejects.toMatchObject({ category: "protocol" });
    expect(h.firmware.actions).toEqual(["stop"]);
  });

  it.each(["timeout", "abort", "disconnect"])("never repeats a start after %s", async (kind) => {
    vi.useFakeTimers();
    const h = setup();
    const controller = new AbortController();
    const respond = vi.fn(h.firmware.respond);
    const connection = new MockConnection(async (payload) => {
      const reply = respond(payload);
      if (respond.mock.calls.length === 2) await new Promise(() => {});
      return reply;
    });
    const session = new EV3DeviceSession(h.session.descriptor, connection);
    const pending = session.run(target, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      category: kind === "timeout" ? "timeout" : kind === "abort" ? "cancelled" : "connection",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(respond).toHaveBeenCalledTimes(2);
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(5000);
    else if (kind === "abort") controller.abort();
    else await session.disconnect();
    await rejected;
    expect(h.firmware.actions.filter((action) => action === "start")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels between stop and load without starting a program", async () => {
    const h = setup(),
      controller = new AbortController();
    vi.spyOn(h.connection, "exchange").mockImplementationOnce(async (payload) => {
      const reply = h.firmware.respond(payload);
      controller.abort();
      return reply;
    });
    await expect(h.session.run(target, controller.signal)).rejects.toMatchObject({
      category: "cancelled",
    });
    expect(h.firmware.actions).toEqual(["stop"]);
  });

  it("does not touch the brick for an invalid path", async () => {
    const h = setup();
    await expect(h.session.run("../bad.rbf", h.signal)).rejects.toBeInstanceOf(
      DeviceOperationError,
    );
    expect(h.firmware.actions).toEqual([]);
  });
});
