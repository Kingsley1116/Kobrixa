import { describe, expect, it, vi } from "vitest";
import { MockConnection } from "./mock.js";
import { EV3DeviceSession } from "./session.js";
import { MOTOR_HELPER } from "./motor-types.js";

type Parameter = number | string | { offset: number };

// Execute public firmware opcodes independently of motor.ts's packet layouts.
// In particular, count and speed use different widths and port-vs-mask operands.
class Firmware {
  requests: Uint8Array[] = [];
  status = 64;
  outputs = [7, 8, 126, 7].map((type, port) => ({
    type,
    ready: true,
    busy: false,
    speed: 0,
    count: -1000 + port,
    tacho: 123 + port,
  }));
  helper = new Uint8Array(24);
  actions: unknown[][] = [];
  loadedPath = "";

  own(token = 123, port = 0): void {
    this.status = 16;
    const data = new DataView(this.helper.buffer);
    data.setInt32(0, 0x4b4d5431, true);
    data.setInt32(4, token, true);
    data.setUint8(14, port);
    data.setInt32(16, -482, true);
  }

  respond = (payload: Uint8Array): Uint8Array => {
    this.requests.push(payload);
    expect(payload[0]).toBe(0);
    expect(payload[2]! & 0xfc).toBe(0);
    const bytes = new Uint8Array(1 + payload[1]! + (payload[2]! << 8));
    bytes[0] = 2;
    const ram = new DataView(bytes.buffer, 1);
    const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let ip = 3;
    const parameter = (): Parameter => {
      const tag = code.getUint8(ip++);
      if (tag === 0x84) {
        const start = ip;
        while (code.getUint8(ip++)) {
          /* zero-terminated literal */
        }
        return new TextDecoder().decode(payload.subarray(start, ip - 1));
      }
      if (!(tag & 0x80)) return tag & 0x40 ? { offset: tag & 31 } : tag & 0x20 ? tag - 64 : tag;
      const width = [0, 1, 2, 4][tag & 3]!;
      if (!width) throw new Error("Bad parameter width");
      const variable = !!(tag & 0x40);
      const value =
        width === 1
          ? variable
            ? code.getUint8(ip)
            : code.getInt8(ip)
          : width === 2
            ? variable
              ? code.getUint16(ip, true)
              : code.getInt16(ip, true)
            : code.getInt32(ip, true);
      ip += width;
      return variable ? { offset: value } : value;
    };
    const read = (width = 1): number => {
      const param = parameter();
      if (typeof param === "string") throw new Error("Unexpected string");
      return typeof param === "number"
        ? param
        : width === 4
          ? ram.getInt32(param.offset, true)
          : ram.getInt8(param.offset);
    };
    const offset = (): number => {
      const param = parameter();
      if (typeof param !== "object") throw new Error("Expected memory operand");
      return param.offset;
    };
    const write = (value: number, width = 1): void => {
      const destination = offset();
      if (width === 4) ram.setInt32(destination, value, true);
      else ram.setUint8(destination, value);
    };
    const localPort = (): number => {
      expect(read()).toBe(0);
      return read();
    };
    while (ip < payload.length) {
      const opcode = code.getUint8(ip++);
      if (opcode === 0x0c) {
        expect(read()).toBe(22);
        expect(read()).toBe(1);
        write(this.status);
      } else if (opcode === 0x30) write(read());
      else if ([0x64, 0x68, 0x70, 0x72].includes(opcode)) {
        const width = opcode === 0x72 ? 4 : 1;
        const left = read(width),
          right = read(width),
          distance = read(4);
        if (opcode === 0x64 ? left < right : opcode === 0x68 ? left > right : left !== right)
          ip += distance;
      } else if (opcode === 0x99) {
        expect(read()).toBe(5);
        const port = localPort() - 16;
        write(this.outputs[port]!.type);
        write(0);
      } else if (opcode === 0x9b) write(this.outputs[localPort() - 16]!.ready ? 0 : 1);
      else if (opcode === 0xa9) {
        const mask = localPort();
        expect([1, 2, 4, 8]).toContain(mask);
        write(this.outputs.some((output, port) => mask & (1 << port) && output.busy) ? 1 : 0);
      } else if (opcode === 0xa8) {
        const output = this.outputs[localPort()]!;
        write(output.speed);
        write(output.tacho, 4);
      } else if (opcode === 0xb3) write(this.outputs[localPort()]!.count, 4);
      else if (opcode === 0xad) {
        const mask = localPort(),
          power = read();
        const rampUp = read(4),
          duration = read(4),
          rampDown = read(4),
          brake = read();
        this.actions.push(["timed", mask, power, rampUp, duration, rampDown, brake]);
      } else if (opcode === 0xa3) this.actions.push(["stop", localPort(), read()]);
      else if (opcode === 0x02) {
        expect(read()).toBe(1);
        this.status = 64;
        this.actions.push(["program-stop"]);
      } else if (opcode === 0x7f || opcode === 0x7e) {
        expect(read(2)).toBe(1);
        expect(read(2)).toBe(0);
        const start = read(4),
          length = read(4),
          position = offset();
        if (this.status === 64) throw new Error("Do not access stopped program memory");
        if (opcode === 0x7f) {
          bytes.subarray(position + 1, position + length + 1).fill(0);
          bytes.set(this.helper.subarray(start, start + length), position + 1);
        } else {
          this.helper.set(bytes.subarray(position + 1, position + length + 1), start);
          this.actions.push(["write", start, length]);
        }
      } else if (opcode === 0xc0) {
        expect(read()).toBe(8);
        expect(read(2)).toBe(1);
        const path = parameter();
        expect(typeof path).toBe("string");
        this.loadedPath = path as string;
        write(300, 4);
        write(400, 4);
        this.actions.push(["load"]);
      } else if (opcode === 0x03) {
        expect(read(2)).toBe(1);
        expect(read(4)).toBe(300);
        expect(read(4)).toBe(400);
        expect(read()).toBe(0);
        this.status = 16;
        this.actions.push(["start"]);
      } else throw new Error(`Unexpected opcode ${opcode.toString(16)}`);
    }
    expect(ip).toBe(payload.length);
    return bytes;
  };
}

function setup() {
  const firmware = new Firmware();
  const connection = new MockConnection(firmware.respond);
  const session = new EV3DeviceSession({ id: "test", name: "EV3", transport: "mock" }, connection);
  return { firmware, connection, session, signal: new AbortController().signal };
}

describe("bounded motor test protocol", () => {
  it("samples output busy flags independently from signed speed and persistent sensor count", async () => {
    const h = setup();
    h.firmware.outputs[0]!.busy = true;
    h.firmware.outputs[1]!.speed = -36;
    h.firmware.outputs[3]!.ready = false;
    expect(await h.session.readMotorTest(h.signal)).toMatchObject({
      programStopped: true,
      outputs: [
        { port: 0, type: 7, angle: -1000, busy: true, speed: 0 },
        { port: 1, type: 8, angle: -999, busy: false, speed: -36 },
        { port: 2, type: 126, angle: null, busy: false, speed: 0 },
        { port: 3, type: 7, angle: null, busy: false, speed: 0 },
      ],
    });
    expect(h.firmware.actions).toEqual([]);
  });

  it.each([0, 1, 2, 3])(
    "encodes a finite signed command for port %i with a mask and no counter reset",
    async (port) => {
      const h = setup();
      h.firmware.outputs[port]!.type = 8;
      await h.session.motorTimed(port, -100, 5000, true, h.signal);
      await h.session.motorStop(port, false, h.signal);
      expect(h.firmware.actions).toEqual([
        ["timed", 1 << port, -100, 0, 5000, 0, 1],
        ["stop", 1 << port, 0],
      ]);
    },
  );

  it.each([16, 0, 32])(
    "guards timed commands and stops in firmware when USER_SLOT is %i",
    async (status) => {
      const h = setup();
      h.firmware.status = status;
      await expect(h.session.motorTimed(0, 20, 400, true, h.signal)).rejects.toThrow(
        "Stop the EV3 program",
      );
      await expect(h.session.motorStop(0, true, h.signal)).rejects.toThrow("Another EV3 program");
      expect(h.firmware.actions).toEqual([]);
    },
  );

  it.each([0, 6, 9, 126, 127])("guards unsupported motor type %i", async (type) => {
    const h = setup();
    h.firmware.outputs[0]!.type = type;
    await expect(h.session.motorTimed(0, 20, 400, true, h.signal)).rejects.toThrow();
    expect(h.firmware.actions).toEqual([]);
  });

  it("rejects an initializing motor and invalid boundaries before exchange", async () => {
    const h = setup();
    h.firmware.outputs[0]!.ready = false;
    await expect(h.session.motorTimed(0, 20, 400, true, h.signal)).rejects.toThrow();
    const requests = h.firmware.requests.length;
    for (const [port, power, duration] of [
      [-1, 20, 400],
      [4, 20, 400],
      [0, 0, 400],
      [0, 101, 400],
      [0, -101, 400],
      [0, NaN, 400],
      [0, 20, 99],
      [0, 20, 5001],
      [0, 20, Infinity],
    ])
      await expect(
        h.session.motorTimed(port!, power!, duration!, true, h.signal),
      ).rejects.toThrow();
    expect(h.firmware.requests).toHaveLength(requests);
    expect(h.firmware.actions).toEqual([]);
  });

  it("only starts a helper in a stopped USER_SLOT, within the guarded command", async () => {
    const h = setup();
    await h.session.runMotorHelper("/home/root/lms2012/prjs/kobrixa/test.rbf", h.signal);
    expect(h.firmware.actions).toEqual([["load"], ["start"]]);
    await expect(
      h.session.runMotorHelper("/home/root/lms2012/prjs/kobrixa/test.rbf", h.signal),
    ).rejects.toThrow();
    expect(h.firmware.actions).toHaveLength(2);
  });

  it("reads and arms only the owned waiting helper; stops the program before stopping its output", async () => {
    const h = setup();
    h.firmware.own(123, 1);
    expect(await h.session.readMotorHelper(123, h.signal)).toEqual({
      owned: true,
      state: 0,
      result: 0,
      angle: -482,
    });
    await h.session.armMotorHelper(123, h.signal);
    expect(new DataView(h.firmware.helper.buffer).getInt32(MOTOR_HELPER.armOffset, true)).toBe(123);
    expect(await h.session.stopMotorHelper(123, 1, true, h.signal)).toBe(true);
    expect(h.firmware.actions).toEqual([["write", 8, 4], ["program-stop"], ["stop", 2, 1]]);
    expect(await h.session.readMotorHelper(123, h.signal)).toEqual({
      owned: false,
      state: 0,
      result: 0,
      angle: null,
    });
  });

  it("does not write or stop on a different helper token, magic, port, or a short unrelated program", async () => {
    const h = setup();
    h.firmware.own();
    await expect(h.session.armMotorHelper(456, h.signal)).rejects.toThrow();
    expect(await h.session.stopMotorHelper(456, 0, true, h.signal)).toBe(false);
    expect(await h.session.stopMotorHelper(123, 1, true, h.signal)).toBe(false);
    h.firmware.helper[0] = 0;
    expect((await h.session.readMotorHelper(123, h.signal)).owned).toBe(false);
    h.firmware.helper = new Uint8Array(2);
    await expect(h.session.armMotorHelper(123, h.signal)).rejects.toThrow();
    expect(await h.session.stopMotorHelper(123, 0, true, h.signal)).toBe(false);
    expect(h.firmware.actions).toEqual([]);
  });

  it("does not arm a finished helper and rejects invalid helper status", async () => {
    const h = setup();
    h.firmware.own();
    h.firmware.helper[12] = 2;
    h.firmware.helper[13] = 2;
    expect(await h.session.readMotorHelper(123, h.signal)).toMatchObject({ state: 2, result: 2 });
    await expect(h.session.armMotorHelper(123, h.signal)).rejects.toThrow();
    h.firmware.helper[12] = 3;
    await expect(h.session.readMotorHelper(123, h.signal)).rejects.toThrow(
      "Invalid motor helper result",
    );
    expect(h.firmware.actions).toEqual([]);
  });

  it.each([new Uint8Array(), Uint8Array.of(2), Uint8Array.of(3, 0), Uint8Array.of(4)])(
    "rejects malformed or error replies",
    async (reply) => {
      const h = setup();
      vi.spyOn(h.connection, "exchange").mockResolvedValue(reply);
      await expect(h.session.readMotorTest(h.signal)).rejects.toThrow();
      await expect(h.session.motorTimed(0, 20, 400, true, h.signal)).rejects.toThrow();
      await expect(h.session.readMotorHelper(123, h.signal)).rejects.toThrow();
    },
  );

  it("shares session exclusivity and never queues an old motor command", async () => {
    const h = setup();
    let release!: (value: Uint8Array) => void;
    vi.spyOn(h.connection, "exchange").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.session.readMotorTest(h.signal);
    await expect(h.session.motorTimed(0, 20, 400, true, h.signal)).rejects.toThrow(
      "already running",
    );
    release(Uint8Array.of(4));
    await expect(pending).rejects.toThrow();
    expect(h.firmware.actions).toEqual([]);
  });
});
