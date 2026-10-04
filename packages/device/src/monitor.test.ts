import { afterEach, describe, expect, it, vi } from "vitest";
import { EV3DeviceSession } from "./session.js";
import { MockConnection } from "./mock.js";

interface Input {
  type: number;
  mode: number;
  connection: number;
  busy: number;
  names: string[];
  views: number;
  unit: string;
  decimals: number;
  values: number[];
}

type Parameter = number | { offset: number };

// A small independent firmware fixture executes the relevant public opcodes,
// including conditional branches. It checks encoded operands and output widths,
// so the tests do not manufacture replies using the implementation's layout.
class Firmware {
  readonly requests: Uint8Array[] = [];
  readonly inputs: Input[] = [
    {
      type: 29,
      mode: 0,
      connection: 122,
      busy: 0,
      names: ["COL-REFLECT", "COL-AMBIENT", "COL-COLOR", "REF-RAW", "RGB-RAW", "COL-CAL"],
      views: 3,
      unit: "pct",
      decimals: 0,
      values: [42],
    },
    {
      type: 32,
      mode: 3,
      connection: 122,
      busy: 0,
      names: ["GYRO-ANG", "GYRO-RATE", "GYRO-FAS", "GYRO-G&A", "GYRO-CAL"],
      views: 2,
      unit: "deg",
      decimals: 1,
      values: [-12.5, 5.5],
    },
    {
      type: 126,
      mode: 0,
      connection: 126,
      busy: 0,
      names: ["NONE"],
      views: 1,
      unit: "",
      decimals: 0,
      values: [],
    },
    {
      type: 33,
      mode: 1,
      connection: 122,
      busy: 0,
      names: ["IR-PROX", "IR-SEEK", "IR-REMOTE", "IR-REM-A", "IR-S-ALT"],
      views: 3,
      unit: "pct",
      decimals: 0,
      values: [0, -25, 30, 50, NaN, 75, Infinity, 100],
    },
  ];
  readonly outputs = [
    { type: 7, connection: 125, busy: 0, name: "L-MOTOR-DEG", angle: -720 },
    { type: 8, connection: 125, busy: 0, name: "M-MOTOR-DEG", angle: 123 },
    { type: 126, connection: 126, busy: 0, name: "NONE", angle: 80 },
    { type: 127, connection: 127, busy: 0, name: "PORT ERROR", angle: 0 },
  ];
  status = 64;
  result = 0;
  percent = 75;
  voltage = 7.5;
  changes: Array<{ port: number; mode: number }> = [];
  beforeCommand?: (count: number) => void;
  beforeValues?: (port: number) => void;
  afterChange?: (port: number) => void;

  respond = (payload: Uint8Array): Uint8Array => {
    this.requests.push(payload);
    this.beforeCommand?.(this.requests.length);
    expect(payload[0]).toBe(0); // Direct command with reply.
    expect(payload[2]! & 0xfc).toBe(0); // No local-memory allocation.
    const globals = payload[1]! | (payload[2]! << 8);
    const buffer = new Uint8Array(globals + 1);
    buffer[0] = 2;
    const data = new DataView(buffer.buffer, 1);
    const code = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let ip = 3;
    const parameter = (): Parameter => {
      const tag = code.getUint8(ip++);
      if (!(tag & 0x80)) return tag & 0x40 ? { offset: tag & 0x1f } : tag & 0x20 ? tag - 64 : tag;
      const width = [0, 1, 2, 4][tag & 3]!;
      expect(width).toBeGreaterThan(0);
      const unsigned = (tag & 0x40) !== 0;
      const value =
        width === 1
          ? unsigned
            ? code.getUint8(ip)
            : code.getInt8(ip)
          : width === 2
            ? unsigned
              ? code.getUint16(ip, true)
              : code.getInt16(ip, true)
            : code.getInt32(ip, true);
      ip += width;
      return unsigned ? { offset: value } : value;
    };
    const read8 = (): number => {
      const value = parameter();
      return typeof value === "number" ? value : data.getInt8(value.offset);
    };
    const destination = (): number => {
      const value = parameter();
      if (typeof value === "number") throw new Error("Expected a global destination");
      return value.offset;
    };
    const put8 = (value: number): void => data.setUint8(destination(), value);
    const text = (value: string, size: number): void => {
      const offset = destination();
      const target = new Uint8Array(data.buffer, data.byteOffset + offset, size);
      target.fill(32);
      const bytes = new TextEncoder().encode(value);
      target.set(bytes.subarray(0, size - 1));
      target[size - 1] = 0;
    };
    const port = (): number => {
      expect(read8()).toBe(0); // Only the attached brick, no daisy chain.
      return read8();
    };
    while (ip < payload.length) {
      const opcode = code.getUint8(ip++);
      if (opcode === 0x99) {
        const subcode = read8();
        const no = port();
        const input = this.inputs[no];
        const output = this.outputs[no - 16];
        expect(input ?? output).toBeDefined();
        if (subcode === 5) {
          put8((input ?? output)!.type);
          put8(input?.mode ?? 0);
        } else if (subcode === 12) put8((input ?? output)!.connection);
        else if (subcode === 2) {
          put8(input!.values.length);
          put8(3);
          put8(input!.names.length);
          put8(input!.views);
        } else if (subcode === 21) {
          const size = read8();
          text(input ? input.names[input.mode]! : output!.name, size);
        } else if (subcode === 6) {
          const size = read8();
          text(input!.unit, size);
        } else if (subcode === 24) {
          put8(5);
          put8(input!.decimals);
        } else if (subcode === 22) {
          const mode = read8();
          const size = read8();
          text(input!.names[mode] ?? "", size);
        } else throw new Error(`Unexpected INPUT_DEVICE subcode ${subcode}`);
      } else if (opcode === 0x9b) {
        const no = port();
        put8((this.inputs[no] ?? this.outputs[no - 16])!.busy);
      } else if (opcode === 0x9e) {
        const no = port();
        expect(read8()).toBe(0); // Must not select a sensor type.
        expect(read8()).toBe(-1); // Monitoring must not select a mode.
        expect(read8()).toBe(0x13); // SI, not RAW or PCT.
        const values = read8();
        expect(values).toBeLessThanOrEqual(8);
        this.beforeValues?.(no);
        for (let index = 0; index < values; index++)
          data.setFloat32(destination(), this.inputs[no]!.values[index] ?? NaN, true);
      } else if (opcode === 0x9d) {
        const no = port();
        expect(read8()).toBe(0);
        const mode = read8();
        this.inputs[no]!.mode = mode;
        this.changes.push({ port: no, mode });
        this.afterChange?.(no);
        data.setFloat32(destination(), this.inputs[no]!.values[0] ?? NaN, true);
      } else if (opcode === 0x81) {
        const subcode = read8();
        if (subcode === 18) put8(this.percent);
        else if (subcode === 1) data.setFloat32(destination(), this.voltage, true);
        else throw new Error(`Unexpected UI_READ subcode ${subcode}`);
      } else if (opcode === 0xb3) {
        const no = port();
        data.setInt32(destination(), this.outputs[no]!.angle, true);
      } else if (opcode === 0x0c) {
        const subcode = read8();
        expect(read8()).toBe(1); // USER_SLOT
        if (subcode === 22) put8(this.status);
        else if (subcode === 24) put8(this.result);
        else throw new Error(`Unexpected PROGRAM_INFO subcode ${subcode}`);
      } else if (opcode === 0x30) {
        const value = read8();
        put8(value);
      } else if (opcode === 0x70 || opcode === 0x74) {
        const left = read8();
        const right = read8();
        const offset = parameter();
        if (typeof offset !== "number") throw new Error("Expected a constant branch offset");
        if (opcode === 0x70 ? left !== right : left <= right) ip += offset;
      } else if (opcode !== 0x02) throw new Error(`Unexpected direct opcode ${opcode}`);
      else expect(read8()).toBe(1);
    }
    expect(ip).toBe(payload.length);
    return buffer;
  };
}

function setup() {
  const firmware = new Firmware();
  const connection = new MockConnection(firmware.respond);
  const session = new EV3DeviceSession({ id: "test", name: "EV3", transport: "mock" }, connection);
  return { firmware, connection, session, signal: new AbortController().signal };
}

afterEach(() => vi.useRealTimers());

describe("EV3 monitor protocol", () => {
  it("reads a bounded batch with SI datasets, metadata, signed angles, battery and program state", async () => {
    const h = setup();
    const exchange = vi.spyOn(h.connection, "exchange");
    const result = await h.session.readMonitor(h.signal);
    expect(result).toMatchObject({
      battery: { percent: 75, voltage: 7.5 },
      program: { status: "stopped", rawStatus: 64, result: 0 },
    });
    expect(result!.inputs[0]).toMatchObject({
      port: 0,
      type: 29,
      connection: 122,
      mode: 0,
      state: "ready",
      name: "COL-REFLECT",
      modeName: "COL-REFLECT",
      unit: "pct",
      values: [42],
      switchable: true,
    });
    expect(result!.inputs[1]).toMatchObject({ values: [-12.5, 5.5], decimals: 1 });
    expect(result!.inputs[2]).toMatchObject({ state: "empty", values: [], switchable: false });
    expect(result!.inputs[3]!.values).toEqual([0, -25, 30, 50, null, 75, null, 100]);
    expect(result!.outputs.map((output) => output.angle)).toEqual([-720, 123, null, null]);
    expect(result!.outputs.map((output) => output.state)).toEqual([
      "ready",
      "ready",
      "empty",
      "error",
    ]);
    expect(h.firmware.requests).toHaveLength(1);
    const request = h.firmware.requests[0]!;
    const globals = request[1]! | (request[2]! << 8);
    expect(globals).toBeLessThanOrEqual(1023);
    expect(globals + 1 + 4).toBeLessThanOrEqual(1024);
    expect(request.length + 5).toBeLessThanOrEqual(1024);
    expect(exchange.mock.calls[0]![2]).toBe(2000);
    expect(h.firmware.changes).toEqual([]);
  });

  it("preserves zero, hides unavailable values, and does not invent a running state", async () => {
    const h = setup();
    h.firmware.inputs[0]!.values = [0];
    h.firmware.inputs[1]!.busy = 1;
    h.firmware.inputs[2]!.type = 125;
    h.firmware.inputs[2]!.connection = 122;
    h.firmware.inputs[2]!.values = [99];
    h.firmware.inputs[3]!.values = [NaN];
    h.firmware.percent = 255;
    h.firmware.voltage = NaN;
    h.firmware.status = 0;
    const result = (await h.session.readMonitor(h.signal))!;
    expect(result.inputs[0]).toMatchObject({ state: "ready", values: [0] });
    expect(result.inputs[1]).toMatchObject({ state: "initializing", values: [null, null] });
    expect(result.inputs[2]).toMatchObject({ state: "unknown", values: [null] });
    expect(result.inputs[3]).toMatchObject({ state: "ready", values: [null], switchable: true });
    expect(result.battery).toEqual({ percent: null, voltage: null });
    expect(result.program.status).toBe("unknown");
  });

  it("discards values if the user program changes sensor mode during the sample", async () => {
    const h = setup();
    h.firmware.beforeValues = (port) => {
      if (port === 0) h.firmware.inputs[port]!.mode = 1;
    };
    const result = (await h.session.readMonitor(h.signal))!;
    expect(result.inputs[0]).toMatchObject({ state: "initializing", values: [null] });
    expect(h.firmware.changes).toHaveLength(0);
  });

  it.each(["wrong-kind", "short", "long", "name", "rejected"])(
    "rejects a %s direct response",
    async (kind) => {
      const h = setup();
      const original = h.connection.exchange.bind(h.connection);
      vi.spyOn(h.connection, "exchange").mockImplementation(async (...args) => {
        const reply = await original(...args);
        if (kind === "wrong-kind") reply[0] = 3;
        if (kind === "short") return reply.slice(0, -1);
        if (kind === "long") return Uint8Array.from([...reply, 0]);
        if (kind === "name") reply.fill(65, 21, 37);
        if (kind === "rejected") return Uint8Array.of(4);
        return reply;
      });
      await expect(h.session.readMonitor(h.signal)).rejects.toMatchObject({
        category: kind === "rejected" ? "device" : "protocol",
      });
    },
  );

  it("keeps transient sensor metadata local to its port instead of failing the connection", async () => {
    const h = setup();
    const original = h.connection.exchange.bind(h.connection);
    vi.spyOn(h.connection, "exchange").mockImplementation(async (...args) => {
      const reply = await original(...args);
      reply[10] = 255; // First input has not established a mode yet.
      reply[19] = 255; // Its mode read back at the end is also -1.
      reply[15] = 255; // Mode count is not available yet.
      return reply;
    });
    h.firmware.voltage = -1;
    const result = (await h.session.readMonitor(h.signal))!;
    expect(result.inputs[0]).toMatchObject({
      mode: -1,
      state: "initializing",
      values: [null],
      switchable: false,
    });
    expect(result.inputs[1]!.state).toBe("ready");
    expect(result.battery.voltage).toBeNull();
    expect(h.connection.closed).toBe(false);
  });

  it("lists Port View mode names without selecting calibration or other modes", async () => {
    const h = setup();
    expect(await h.session.readInputModes(0, 29, h.signal)).toEqual({
      port: 0,
      type: 29,
      modes: [
        { mode: 0, name: "COL-REFLECT" },
        { mode: 1, name: "COL-AMBIENT" },
        { mode: 2, name: "COL-COLOR" },
      ],
    });
    expect(h.firmware.requests).toHaveLength(2);
    expect(h.firmware.changes).toEqual([]);
  });

  it.each([
    [5, 120],
    [16, 121],
    [50, 122],
  ])("leaves touch, third-party and I2C sensors read-only (type %i)", async (type, connection) => {
    const h = setup();
    h.firmware.inputs[0]!.type = type;
    h.firmware.inputs[0]!.connection = connection;
    expect(await h.session.readInputModes(0, type, h.signal)).toEqual({ port: 0, type, modes: [] });
    expect(h.firmware.requests).toHaveLength(1);
    expect((await h.session.readMonitor(h.signal))!.inputs[0]!.switchable).toBe(false);
  });

  it("detects a sensor swap while loading its mode names", async () => {
    const h = setup();
    h.firmware.beforeCommand = (count) => {
      if (count === 2) h.firmware.inputs[0]!.type = 33;
    };
    await expect(h.session.readInputModes(0, 29, h.signal)).rejects.toThrow("sensor changed");
  });

  it("yields before any exchange or between mode metadata and names", async () => {
    const h = setup();
    expect(await h.session.readMonitor(h.signal, () => true)).toBeUndefined();
    expect(h.firmware.requests).toHaveLength(0);
    expect(
      await h.session.readInputModes(0, 29, h.signal, () => h.firmware.requests.length > 0),
    ).toBeUndefined();
    expect(h.firmware.requests).toHaveLength(1);
    await expect(h.session.stop(undefined, h.signal)).resolves.toBeUndefined();
  });

  it("finishes an in-flight exchange before yielding without aborting its signal", async () => {
    const h = setup();
    let finish!: (reply: Uint8Array) => void;
    let yielded = false;
    vi.spyOn(h.connection, "exchange").mockImplementationOnce(async (payload, signal) => {
      const reply = await new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      });
      expect(signal.aborted).toBe(false);
      return reply.length ? reply : h.firmware.respond(payload);
    });
    const reading = h.session.readMonitor(h.signal, () => yielded);
    await expect(h.session.stop(undefined, h.signal)).rejects.toThrow("already running");
    yielded = true;
    finish(new Uint8Array());
    expect(await reading).toBeUndefined();
    expect(h.connection.closed).toBe(false);
    await expect(h.session.stop(undefined, h.signal)).resolves.toBeUndefined();
  });

  it("bounds an unanswered read to two seconds", async () => {
    vi.useFakeTimers();
    const connection = new MockConnection(() => new Promise<Uint8Array>(() => {}));
    const session = new EV3DeviceSession(
      { id: "test", name: "EV3", transport: "mock" },
      connection,
    );
    const reading = session.readMonitor(new AbortController().signal);
    const rejected = expect(reading).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
  });
});

describe("EV3 sensor mode changes", () => {
  it("guards the change on the brick and returns a refreshed snapshot", async () => {
    const h = setup();
    const result = await h.session.setInputMode(0, 29, 1, h.signal);
    expect(h.firmware.changes).toEqual([{ port: 0, mode: 1 }]);
    expect(result.inputs[0]).toMatchObject({ mode: 1, modeName: "COL-AMBIENT", state: "ready" });
    expect(h.firmware.requests).toHaveLength(2);
  });

  it.each([
    "running",
    "unknown-status",
    "type",
    "connection",
    "busy",
    "internal-mode",
    "mode-count",
  ])(
    "refuses a %s state in the same direct command without changing the sensor",
    async (reason) => {
      const h = setup();
      h.firmware.beforeCommand = () => {
        if (reason === "running") h.firmware.status = 16;
        if (reason === "unknown-status") h.firmware.status = 0;
        if (reason === "type") h.firmware.inputs[0]!.type = 33;
        if (reason === "connection") h.firmware.inputs[0]!.connection = 120;
        if (reason === "busy") h.firmware.inputs[0]!.busy = 1;
        if (reason === "mode-count") h.firmware.inputs[0]!.names = ["COL-REFLECT"];
      };
      await expect(
        h.session.setInputMode(0, 29, reason === "internal-mode" ? 3 : 1, h.signal),
      ).rejects.toMatchObject({ category: "device" });
      expect(h.firmware.changes).toEqual([]);
      expect(h.firmware.requests).toHaveLength(1);
    },
  );

  it.each([
    [-1, 29, 0],
    [4, 29, 0],
    [0, 29, -1],
    [0, 29, 8],
    [0, 29, 0.5],
    [0, 5, 0],
    [0, 16, 0],
  ])("rejects invalid port/type/mode %i/%i/%i without I/O", async (port, type, mode) => {
    const h = setup();
    await expect(h.session.setInputMode(port, type, mode, h.signal)).rejects.toMatchObject({
      category: "device",
    });
    expect(h.firmware.requests).toHaveLength(0);
  });

  it("allows a UART sensor time to settle without repeating the mode write", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.firmware.afterChange = (port) => {
      h.firmware.inputs[port]!.busy = 1;
    };
    h.firmware.beforeCommand = (count) => {
      if (count >= 4) h.firmware.inputs[0]!.busy = 0;
    };
    const pending = h.session.setInputMode(0, 29, 1, h.signal);
    await vi.advanceTimersByTimeAsync(300);
    expect((await pending).inputs[0]!.state).toBe("ready");
    expect(h.firmware.changes).toEqual([{ port: 0, mode: 1 }]);
    expect(h.firmware.requests).toHaveLength(4);
  });

  it("stops settling after five seconds without resetting the sensor or losing the connection", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.firmware.afterChange = (port) => {
      h.firmware.inputs[port]!.busy = 1;
    };
    const pending = h.session.setInputMode(0, 29, 1, h.signal);
    const rejected = expect(pending).rejects.toMatchObject({ category: "device" });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(h.firmware.changes).toEqual([{ port: 0, mode: 1 }]);
    expect(h.firmware.requests.length).toBeLessThanOrEqual(51);
    expect(h.connection.closed).toBe(false);
  });

  it("reports removal or a program starting while the mode settles", async () => {
    for (const scenario of ["removed", "running"]) {
      const h = setup();
      h.firmware.afterChange = (port) => {
        h.firmware.inputs[port]!.busy = 1;
        if (scenario === "removed") h.firmware.inputs[port]!.type = 126;
        else h.firmware.status = 16;
      };
      await expect(h.session.setInputMode(0, 29, 1, h.signal)).rejects.toMatchObject({
        category: "device",
      });
      expect(h.firmware.changes).toHaveLength(1);
      expect(h.firmware.requests).toHaveLength(2);
    }
  });

  it("cancels a settling wait without sending another command or restoring the mode", async () => {
    vi.useFakeTimers();
    const h = setup();
    const controller = new AbortController();
    h.firmware.afterChange = (port) => {
      h.firmware.inputs[port]!.busy = 1;
    };
    const pending = h.session.setInputMode(0, 29, 1, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ category: "cancelled" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.firmware.requests).toHaveLength(2);
    expect(h.firmware.changes).toEqual([{ port: 0, mode: 1 }]);
    expect(h.connection.closed).toBe(false);
    await expect(h.session.stop(undefined, h.signal)).resolves.toBeUndefined();
  });
});
