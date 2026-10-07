import type { Pixy2Block, RobotConfig, SimulationSensor } from "../shared/simulator.js";
import {
  VirtualDevice,
  type PreviewDeviceOptions,
  type PreviewDeviceSnapshot,
  type PreviewInputs,
  type PreviewInvokeContext,
  type PreviewInvokeResult,
  type PreviewSensorPort,
  type PreviewValue,
} from "../preview/virtual-device.js";
import type { SimulationMailboxBus } from "./mailbox.js";
import { Pixy2Protocol } from "./pixy2-protocol.js";

export interface SimulationSensorReading {
  si: number[];
  raw?: number[];
  percent?: number;
  busy?: boolean;
  /** LEGO image bytes, sorted by descending native image area with stable ties. */
  pixy2?: Pixy2Block[];
}
export interface SimulationDeviceOptions extends PreviewDeviceOptions {
  robot: RobotConfig;
  mailbox: SimulationMailboxBus;
  /** Must read the frozen beginning-of-tick world state, in the requested current mode. */
  readSensor(sensor: SimulationSensor, mode: number): SimulationSensorReading;
}
const TYPES: Record<SimulationSensor["kind"], { type: number; name: string }> = {
  color: { type: 29, name: "EV3-COLOR" },
  ultrasonic: { type: 30, name: "EV3-US" },
  gyro: { type: 32, name: "EV3-GYRO" },
  touch: { type: 16, name: "EV3-TOUCH" },
  vision: { type: 124, name: "KOBRIXA-VISION" },
  // Generic simulator I2C placeholder, not a firmware-assigned Pixy2 type ID.
  pixy2: { type: 100, name: "Pixy2" },
};

/** EV3-compatible peripherals backed by a local physical world, never a host or network API. */
export class SimulationDevice extends VirtualDevice {
  private readonly config: RobotConfig;
  private readonly mailbox: SimulationMailboxBus;
  private readonly readSensor: SimulationDeviceOptions["readSensor"];
  private readonly modes = new Map<PreviewSensorPort, number>();
  private readonly pixy2 = new Map<PreviewSensorPort, Pixy2Protocol>();
  private readonly gyroOffsets = new Map<PreviewSensorPort, number>();

  constructor(options: SimulationDeviceOptions) {
    super(options);
    this.config = options.robot;
    this.mailbox = options.mailbox;
    this.readSensor = options.readSensor;
    for (const sensor of this.config.sensors) {
      if (this.modes.has(sensor.port))
        throw new Error(`Duplicate simulation sensor port ${sensor.port}.`);
      this.modes.set(sensor.port, 0);
      if (sensor.kind === "pixy2") this.pixy2.set(sensor.port, new Pixy2Protocol());
    }
  }

  override setInputs(inputs: PreviewInputs): void {
    // Buttons and battery remain controllable; environment sensors belong to the world.
    const controls = { ...inputs };
    delete controls.sensors;
    super.setInputs(controls);
  }

  override snapshot(): PreviewDeviceSnapshot {
    this.refreshSensors();
    return super.snapshot();
  }

  override invoke(
    operation: string,
    args: PreviewValue[],
    nowMs: number,
    context?: PreviewInvokeContext,
  ): PreviewInvokeResult {
    if (operation === "EV3.BrickName") return { value: this.config.name };
    if (operation.startsWith("Mailbox."))
      return this.invokeMailbox(operation.slice(8), args, context);
    if (operation === "Sensor.SendUARTData") {
      super.invoke("EV3.Time", [], nowMs);
      return this.invokeUART(args);
    }
    if (
      /^Sensor\.(ReadI2CRegister|ReadI2CRegisters|WriteI2CRegister|WriteI2CRegisters|CommunicateI2C)$/.test(
        operation,
      )
    ) {
      super.invoke("EV3.Time", [], nowMs);
      return this.invokeI2C(operation.slice(7), args);
    }
    if (operation === "Sensor.SetMode") {
      const port = Number(args[0]);
      const mode = Number(args[1]);
      if (!Number.isInteger(mode) || mode < 0 || mode > 7)
        throw new Error("Simulation sensor modes must be integers from 0 through 7.");
      const sensor = this.config.sensors.find((sensor) => sensor.port === port);
      if (sensor?.kind === "vision" && mode > 2)
        throw new Error("KOBRIXA-VISION supports modes 0 (all), 1 (orange), and 2 (purple).");
      if (sensor?.kind === "pixy2" && mode !== 0)
        throw new Error(
          "Pixy2 supports mode 0 (largest-block X port view); select signatures with I2C registers 0x51–0x57.",
        );
      if (this.modes.has(port as PreviewSensorPort))
        this.modes.set(port as PreviewSensorPort, mode);
    }
    if (operation.startsWith("Sensor.") || /^Sensor[1-4]\./.test(operation)) this.refreshSensors();
    return super.invoke(operation, args, nowMs, context);
  }

  private refreshSensors(): void {
    for (const sensor of this.config.sensors) {
      const mode = this.modes.get(sensor.port) ?? 0;
      const reading = this.readSensor(sensor, mode);
      let si = reading.si.slice(0, 8);
      let raw = reading.raw?.slice(0, 8) ?? si.map(Math.trunc);
      let percent = reading.percent ?? si[0] ?? 0;
      if (sensor.kind === "gyro" && (mode === 0 || mode === 3)) {
        // Reset the angle reference, not the body's pose or its angular velocity.
        // Quantize after subtraction so resetting a fractional heading reads exactly zero.
        si[0] = (si[0] ?? 0) - (this.gyroOffsets.get(sensor.port) ?? 0);
        raw[0] = Math.trunc(si[0]);
        percent = si[0];
      }
      if (sensor.kind === "vision") {
        if (mode > 2)
          throw new Error("KOBRIXA-VISION supports modes 0 (all), 1 (orange), and 2 (purple).");
        const detected = si[0] ? 1 : 0;
        const kind = si[3];
        if (!detected || (mode === 1 && kind !== 1) || (mode === 2 && kind !== 2))
          si = [0, 0, 0, 0];
        else si = [1, si[1] ?? 0, si[2] ?? 0, kind ?? 0];
        raw = si.map(Math.trunc);
        percent = si[0]! * 100;
      }
      if (sensor.kind === "pixy2") {
        // LEGO's 0x42 port view is X only, not KOBRIXA-VISION's four channels.
        const x = reading.pixy2?.[0]?.x ?? 0;
        si = [x];
        raw = [x];
        percent = Math.round((x * 100) / 255);
      }
      if (
        si.some((value) => !Number.isFinite(value)) ||
        raw.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(percent)
      )
        throw new Error(`Simulation sensor ${sensor.port} returned a nonfinite environment value.`);
      super.setInputs({
        sensors: {
          [sensor.port]: {
            ...TYPES[sensor.kind],
            mode,
            si,
            raw,
            percent,
            busy: reading.busy ?? false,
          },
        },
      });
    }
  }

  private invokeUART(args: PreviewValue[]): PreviewInvokeResult {
    if (args.length !== 3) throw new Error("Sensor.SendUARTData requires 3 arguments.");
    const [port, count, payload] = args;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 4)
      throw new Error("UART sensor port must be an integer from 1 through 4.");
    const sensor = this.config.sensors.find((item) => item.port === port);
    if (sensor?.kind !== "gyro")
      throw new Error(`Sensor port ${port} has no simulated EV3 gyro for UART commands.`);
    if (
      count !== 1 ||
      !Array.isArray(payload) ||
      typeof payload[0] !== "number" ||
      !Number.isFinite(payload[0]) ||
      (Math.trunc(payload[0]) & 255) !== 17
    )
      throw new Error(
        "Simulated gyro UART supports only the angle-reset command: one numeric payload byte 17.",
      );
    const angle = this.readSensor(sensor, 0).si[0];
    if (angle === undefined || !Number.isFinite(angle))
      throw new Error(`Simulation gyro ${port} returned a nonfinite angle.`);
    this.gyroOffsets.set(sensor.port, angle);
    this.event("Sensor.SendUARTData", `EV3 gyro S${port} angle reset`);
    return {};
  }

  private invokeI2C(method: string, args: PreviewValue[]): PreviewInvokeResult {
    const expectedArgs =
      method === "ReadI2CRegister"
        ? 3
        : method === "ReadI2CRegisters" || method === "WriteI2CRegister"
          ? 4
          : 5;
    if (args.length !== expectedArgs)
      throw new Error(`Sensor.${method} requires ${expectedArgs} arguments.`);
    const port = this.i2cInteger(args[0], 1, 4, "sensor port") as PreviewSensorPort;
    if (args[1] !== 1) throw new Error("Simulated Pixy2 uses LEGO I2C 7-bit address 1.");
    const camera = this.pixy2.get(port);
    const sensor = this.config.sensors.find((item) => item.port === port);
    if (!camera || !sensor) throw new Error(`Sensor port ${port} has no simulated Pixy2 camera.`);

    const writing = method === "WriteI2CRegister" || method === "WriteI2CRegisters";
    const readBytes = writing
      ? 0
      : method === "ReadI2CRegister"
        ? 1
        : this.i2cInteger(args[3], 1, 32, "read byte count");
    let request: number[];
    if (method === "CommunicateI2C") {
      const count = this.i2cInteger(args[2], 0, 31, "write byte count");
      request = this.i2cPayload(args[4], count);
    } else {
      request = [this.i2cInteger(args[2], 0, 255, "register")];
      if (method === "WriteI2CRegister") request.push(this.i2cByte(args[3]));
      else if (method === "WriteI2CRegisters") {
        const count = this.i2cInteger(args[3], 0, 30, "write byte count");
        request.push(...this.i2cPayload(args[4], count));
      }
    }
    const blocks = this.readSensor(sensor, 0).pixy2 ?? [];
    const reply = camera.exchange(request, readBytes, blocks);
    if (request[0] === 0x62)
      this.event(
        `Sensor.${method}`,
        `Pixy2 S${port} lamp ${camera.lamp ? "on" : "off"} (illumination is not simulated)`,
      );
    return writing ? {} : { value: method === "ReadI2CRegister" ? reply[0]! : reply };
  }

  private i2cInteger(
    value: PreviewValue | undefined,
    min: number,
    max: number,
    label: string,
  ): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
      throw new Error(`Pixy2 I2C ${label} must be an integer from ${min} through ${max}.`);
    return value;
  }

  private i2cByte(value: PreviewValue | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("Pixy2 I2C payload bytes must be finite numbers.");
    // Match the backend's numeric-row element conversion to an unsigned byte.
    return Math.trunc(value) & 255;
  }

  private i2cPayload(value: PreviewValue | undefined, count: number): number[] {
    if (!Array.isArray(value) || value.length < count)
      throw new Error(
        `Pixy2 I2C payload must be a numeric array containing at least ${count} elements; scalar payloads are not packed into bytes.`,
      );
    return value.slice(0, count).map((byte) => this.i2cByte(byte));
  }

  private invokeMailbox(
    method: string,
    args: PreviewValue[],
    context?: PreviewInvokeContext,
  ): PreviewInvokeResult {
    const id = this.config.id;
    if (method === "Create" || method === "CreateForNumber") {
      if (context?.mailboxHandle === undefined)
        throw new Error("Mailbox.Create requires a statically allocated program callsite.");
      const value = this.mailbox.open(
        id,
        context.mailboxHandle,
        String(args[0]),
        method === "Create" ? "text" : "number",
      );
      this.event(`Mailbox.${method}`, `${String(args[0])} (${value})`);
      return { value };
    }
    if (method === "Connect") {
      this.mailbox.connect(id, String(args[0]));
      this.event("Mailbox.Connect", String(args[0]));
      return {};
    }
    if (method === "Send" || method === "SendNumber") {
      this.mailbox.send(
        id,
        String(args[0]),
        String(args[1]),
        method === "Send" ? "text" : "number",
        method === "Send" ? String(args[2]) : Number(args[2]),
      );
      this.event(
        `Mailbox.${method}`,
        `${String(args[0])} / ${String(args[1])}: ${String(args[2])}`,
      );
      return {};
    }
    if (method === "IsAvailable") return { value: this.mailbox.available(id, Number(args[0])) };
    if (method === "Receive" || method === "ReceiveNumber") {
      const value = this.mailbox.receive(
        id,
        Number(args[0]),
        method === "Receive" ? "text" : "number",
      );
      // Retry at the next simulation tick, never spin or advance the shared clock.
      return value === undefined ? { retry: true, waitMs: 10 } : { value };
    }
    throw new Error(`Mailbox.${method} is unavailable in the local simulator.`);
  }
}
