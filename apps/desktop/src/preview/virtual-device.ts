/** Browser-only, deterministic EV3 peripherals. No operation accesses the host or a real brick. */
export type PreviewValue = number | string | boolean | PreviewValue[];
export type PreviewButton = "up" | "down" | "left" | "right" | "enter" | "back";
export type PreviewPort = "A" | "B" | "C" | "D";
export type PreviewSensorPort = 1 | 2 | 3 | 4;
export interface PreviewSensor {
  type: number;
  mode: number;
  name: string;
  percent: number;
  raw: number[];
  si: number[];
  busy: boolean;
}
export interface PreviewInputs {
  buttons?: PreviewButton[];
  sensors?: Partial<Record<PreviewSensorPort, Partial<PreviewSensor>>>;
  batteryLevel?: number;
  batteryVoltage?: number;
  batteryCurrent?: number;
}
export interface PreviewMotor {
  port: PreviewPort;
  speed: number;
  count: number;
  busy: boolean;
  brake: boolean;
  polarity: number;
}
/** Identity of the immutable IR instruction, shared by threads and loop iterations. */
export interface PreviewInvokeContext {
  callsite: string;
  mailboxHandle?: number;
}
export interface PreviewDeviceSnapshot {
  timeMs: number;
  lcd: { width: number; height: number; pixels: number[]; revision: number };
  motors: Record<PreviewPort, PreviewMotor>;
  sensors: Record<PreviewSensorPort, PreviewSensor>;
  buttons: PreviewButton[];
  batteryLevel: number;
  led: { color: string; effect: string };
  speaker: { busy: boolean; frequency: number; volume: number };
  events: { id: number; timeMs: number; operation: string; detail: string }[];
  files: { path: string; size: number }[];
}
export interface PreviewDeviceOptions {
  runtimeDirectory?: string;
  /** Project resources copied by the caller; writable copies exist only for this preview run. */
  files?: Record<string, number[]>;
}
export interface PreviewInvokeResult {
  value?: PreviewValue;
  waitMs?: number;
  retry?: boolean;
  writes?: Record<number, PreviewValue>;
  end?: boolean;
}

const WIDTH = 178;
const HEIGHT = 128;
const MAX_EVENTS = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 64;
const MAX_ARRAY = 16384;
const PORTS: PreviewPort[] = ["A", "B", "C", "D"];
const SENSOR_PORTS: PreviewSensorPort[] = [1, 2, 3, 4];
const BUTTONS: PreviewButton[] = ["up", "down", "left", "right", "enter", "back"];
const BUTTON_LETTERS = ["U", "D", "L", "R", "E"];

// A small original 5×7 raster alphabet. Preview text approximates EV3 font metrics;
// it intentionally does not depend on installed OS fonts or remote resources.
const GLYPHS: Record<string, string> = {
  " ": "00000/00000/00000/00000/00000/00000/00000",
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01111/10000/10000/10000/10000/10000/01111",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01111/10000/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "11111/00100/00100/00100/00100/00100/11111",
  J: "00111/00010/00010/00010/10010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/11001/10101/10011/10011/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/11011/10001",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
  a: "00000/00000/01110/00001/01111/10001/01111",
  b: "10000/10000/10110/11001/10001/10001/11110",
  c: "00000/00000/01111/10000/10000/10000/01111",
  d: "00001/00001/01101/10011/10001/10001/01111",
  e: "00000/00000/01110/10001/11111/10000/01111",
  f: "00110/01001/01000/11100/01000/01000/01000",
  g: "00000/01111/10001/10001/01111/00001/01110",
  h: "10000/10000/10110/11001/10001/10001/10001",
  i: "00100/00000/01100/00100/00100/00100/01110",
  j: "00010/00000/00110/00010/00010/10010/01100",
  k: "10000/10000/10010/10100/11000/10100/10010",
  l: "01100/00100/00100/00100/00100/00100/01110",
  m: "00000/00000/11010/10101/10101/10101/10101",
  n: "00000/00000/10110/11001/10001/10001/10001",
  o: "00000/00000/01110/10001/10001/10001/01110",
  p: "00000/11110/10001/10001/11110/10000/10000",
  q: "00000/01111/10001/10001/01111/00001/00001",
  r: "00000/00000/10110/11001/10000/10000/10000",
  s: "00000/00000/01111/10000/01110/00001/11110",
  t: "01000/01000/11100/01000/01000/01001/00110",
  u: "00000/00000/10001/10001/10001/10011/01101",
  v: "00000/00000/10001/10001/10001/01010/00100",
  w: "00000/00000/10001/10001/10101/10101/01010",
  x: "00000/00000/10001/01010/00100/01010/10001",
  y: "00000/10001/10001/10001/01111/00001/01110",
  z: "00000/00000/11111/00010/00100/01000/11111",
  "0": "01110/10001/10011/10101/11001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111",
  "3": "11110/00001/00001/01110/00001/00001/11110",
  "4": "00010/00110/01010/10010/11111/00010/00010",
  "5": "11111/10000/10000/11110/00001/00001/11110",
  "6": "01110/10000/10000/11110/10001/10001/01110",
  "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110",
  "9": "01110/10001/10001/01111/00001/00001/01110",
  ".": "00000/00000/00000/00000/00000/00110/00110",
  ",": "00000/00000/00000/00000/00110/00100/01000",
  ":": "00000/00110/00110/00000/00110/00110/00000",
  ";": "00000/00110/00110/00000/00110/00100/01000",
  "!": "00100/00100/00100/00100/00100/00000/00100",
  "?": "01110/10001/00001/00010/00100/00000/00100",
  "-": "00000/00000/00000/11111/00000/00000/00000",
  "+": "00000/00100/00100/11111/00100/00100/00000",
  "=": "00000/00000/11111/00000/11111/00000/00000",
  "/": "00001/00010/00010/00100/01000/01000/10000",
  "\\": "10000/01000/01000/00100/00010/00010/00001",
  "(": "00010/00100/01000/01000/01000/00100/00010",
  ")": "01000/00100/00010/00010/00010/00100/01000",
  "[": "01110/01000/01000/01000/01000/01000/01110",
  "]": "01110/00010/00010/00010/00010/00010/01110",
  "<": "00001/00010/00100/01000/00100/00010/00001",
  ">": "10000/01000/00100/00010/00100/01000/10000",
  "%": "11001/11010/00100/00100/01000/10110/00110",
  _: "00000/00000/00000/00000/00000/00000/11111",
  "'": "00100/00100/00000/00000/00000/00000/00000",
  '"': "01010/01010/00000/00000/00000/00000/00000",
  "*": "00000/10101/01110/11111/01110/10101/00000",
  "#": "01010/01010/11111/01010/11111/01010/01010",
};

function numeric(value: PreviewValue | undefined): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error("Preview requires a finite numeric value.");
  return result;
}
function integer(value: PreviewValue | undefined): number {
  return Math.trunc(numeric(value));
}
function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function arrayLength(value: PreviewValue | undefined): number {
  const length = integer(value);
  if (length < 0 || length > MAX_ARRAY) throw new Error(`Preview array limit is ${MAX_ARRAY}.`);
  return length;
}
function sensorCopy(sensor: PreviewSensor): PreviewSensor {
  return { ...sensor, raw: [...sensor.raw], si: [...sensor.si] };
}

interface MotorState extends PreviewMotor {
  setting: number;
  remaining: number | null;
}
interface FileHandle {
  path: string;
  offset: number;
  writable: boolean;
}

export class VirtualDevice {
  private nowMs = 0;
  private readonly backBuffer = new Uint8Array(WIDTH * HEIGHT);
  private readonly frontBuffer = new Uint8Array(WIDTH * HEIGHT);
  private revision = 0;
  private autoUpdate = true;
  private font = 0;
  private buttons = new Set<PreviewButton>();
  private clicks = new Set<PreviewButton>();
  private readonly timers = new Array<number>(9).fill(0);
  private readonly motors: Record<PreviewPort, MotorState> = Object.fromEntries(
    PORTS.map((port) => [
      port,
      {
        port,
        speed: 0,
        count: 0,
        busy: false,
        brake: false,
        polarity: 1,
        setting: 0,
        remaining: null,
      },
    ]),
  ) as Record<PreviewPort, MotorState>;
  private readonly shaftDeltas: Record<PreviewPort, number> = { A: 0, B: 0, C: 0, D: 0 };
  private readonly sensors: Record<PreviewSensorPort, PreviewSensor> = Object.fromEntries(
    SENSOR_PORTS.map((port) => [
      port,
      { type: 0, mode: 0, name: "NONE", percent: 0, raw: [0], si: [0], busy: false },
    ]),
  ) as Record<PreviewSensorPort, PreviewSensor>;
  private batteryLevel = 100;
  private batteryVoltage = 8;
  private batteryCurrent = 0.1;
  private led = { color: "off", effect: "normal" };
  private speaker = { frequency: 0, volume: 0, until: 0 };
  private readonly events: PreviewDeviceSnapshot["events"] = [];
  private nextEventId = 1;
  private readonly files = new Map<string, number[]>();
  private readonly handles = new Map<number, FileHandle>();
  private nextHandle = 1;
  private readonly directory: string;

  constructor(options: PreviewDeviceOptions = {}) {
    this.directory = options.runtimeDirectory ?? "/home/root/lms2012/prjs";
    for (const [path, bytes] of Object.entries(options.files ?? {})) {
      this.storeFile(
        this.path(path),
        bytes.map((byte) => integer(byte) & 255),
      );
    }
  }

  setInputs(inputs: PreviewInputs): void {
    if (inputs.buttons) {
      const next = new Set(inputs.buttons.filter((button) => BUTTONS.includes(button)));
      for (const button of this.buttons) if (!next.has(button)) this.clicks.add(button);
      this.buttons = next;
    }
    for (const port of SENSOR_PORTS) {
      const update = inputs.sensors?.[port];
      if (!update) continue;
      const sensor = this.sensors[port];
      if (update.type !== undefined) sensor.type = integer(update.type);
      if (update.mode !== undefined) sensor.mode = integer(update.mode);
      if (update.name !== undefined) sensor.name = update.name.slice(0, 32);
      if (update.percent !== undefined)
        sensor.percent = bounded(integer(update.percent), -100, 100);
      if (update.raw !== undefined) sensor.raw = update.raw.slice(0, 8).map(integer);
      if (update.si !== undefined) sensor.si = update.si.slice(0, 8).map(numeric);
      if (update.busy !== undefined) sensor.busy = Boolean(update.busy);
    }
    if (inputs.batteryLevel !== undefined)
      this.batteryLevel = bounded(integer(inputs.batteryLevel), 0, 100);
    if (inputs.batteryVoltage !== undefined)
      this.batteryVoltage = bounded(numeric(inputs.batteryVoltage), 0, 20);
    if (inputs.batteryCurrent !== undefined)
      this.batteryCurrent = bounded(numeric(inputs.batteryCurrent), 0, 20);
  }

  advance(elapsedMs: number): void {
    const elapsed = Math.max(0, numeric(elapsedMs));
    this.nowMs += elapsed;
    for (const motor of Object.values(this.motors)) {
      if (!motor.busy) continue;
      // Ideal unloaded motor: 100% = 720°/s. No physics, inertia or stall model.
      const distance = (Math.abs(motor.speed) * 7.2 * elapsed) / 1000;
      const moved = motor.remaining === null ? distance : Math.min(distance, motor.remaining);
      motor.count += Math.sign(motor.speed) * moved;
      this.shaftDeltas[motor.port] += Math.sign(motor.speed) * moved;
      if (motor.remaining !== null) {
        motor.remaining = Math.max(0, motor.remaining - moved);
        if (motor.remaining === 0) {
          motor.busy = false;
          motor.speed = 0;
        }
      }
    }
  }

  /** Physical shaft motion since the last sample; encoder resets never alter this accumulator. */
  consumeShaftDeltas(): Record<PreviewPort, number> {
    const deltas = { ...this.shaftDeltas };
    for (const port of PORTS) this.shaftDeltas[port] = 0;
    return deltas;
  }

  /**
   * Reconcile a world's already-consumed shaft sample with traction-limited travel.
   * Called after physics and before any next program instruction. Keep scheduled
   * motion pending when a wheel stalls; ResetCount never changes the shaft sample.
   */
  constrainShaftTravel(port: PreviewPort, attempted: number, delivered: number): void {
    if (
      !Number.isFinite(attempted) ||
      !Number.isFinite(delivered) ||
      Math.abs(delivered) > Math.abs(attempted) + 1e-9 ||
      attempted * delivered < 0
    )
      throw new Error("Invalid traction-limited shaft travel.");
    const motor = this.motors[port];
    motor.count += delivered - attempted;
    if (motor.remaining !== null) {
      motor.remaining += Math.abs(attempted) - Math.abs(delivered);
      if (motor.remaining > 1e-9) {
        motor.busy = true;
        motor.speed = motor.setting * motor.polarity;
      }
    }
  }

  /** Cheap actuator state for a world tick, without copying the LCD or event log. */
  motorStates(): Record<PreviewPort, PreviewMotor & { setting: number }> {
    return Object.fromEntries(
      PORTS.map((port) => {
        const motor = this.motors[port];
        return [
          port,
          {
            port,
            speed: motor.speed,
            count: motor.count,
            busy: motor.busy,
            brake: motor.brake,
            polarity: motor.polarity,
            setting: motor.setting,
          },
        ];
      }),
    ) as Record<PreviewPort, PreviewMotor & { setting: number }>;
  }

  snapshot(): PreviewDeviceSnapshot {
    return {
      timeMs: this.nowMs,
      lcd: {
        width: WIDTH,
        height: HEIGHT,
        pixels: Array.from(this.frontBuffer),
        revision: this.revision,
      },
      motors: Object.fromEntries(
        PORTS.map((port) => {
          const motor = this.motors[port];
          return [
            port,
            {
              port,
              speed: motor.speed,
              count: Math.round(motor.count * 1000) / 1000,
              busy: motor.busy,
              brake: motor.brake,
              polarity: motor.polarity,
            },
          ];
        }),
      ) as Record<PreviewPort, PreviewMotor>,
      sensors: Object.fromEntries(
        SENSOR_PORTS.map((port) => [port, sensorCopy(this.sensors[port])]),
      ) as Record<PreviewSensorPort, PreviewSensor>,
      buttons: BUTTONS.filter((button) => this.buttons.has(button)),
      batteryLevel: this.batteryLevel,
      led: { ...this.led },
      speaker: {
        busy: this.speaker.until > this.nowMs,
        frequency: this.speaker.frequency,
        volume: this.speaker.volume,
      },
      events: this.events.map((event) => ({ ...event })),
      files: [...this.files].map(([path, bytes]) => ({ path, size: bytes.length })),
    };
  }

  invoke(
    operation: string,
    args: PreviewValue[],
    nowMs: number,
    _context?: PreviewInvokeContext,
  ): PreviewInvokeResult {
    if (nowMs > this.nowMs) this.advance(nowMs - this.nowMs);
    const timer = /^Time\.(Get|Reset)([1-9])$/.exec(operation);
    if (timer) {
      const index = Number(timer[2]) - 1;
      if (timer[1] === "Reset") this.timers[index] = this.nowMs;
      return timer[1] === "Get" ? { value: Math.trunc(this.nowMs - this.timers[index]!) } : {};
    }
    if (operation.startsWith("LCD.")) return this.display(operation, args);
    if (operation.startsWith("Motor.")) return this.motor(operation.slice(6), args);
    const legacyMotor = /^Motor([ABCD]{1,2})\.(.+)$/.exec(operation);
    if (legacyMotor) return this.legacyMotor(legacyMotor[1]!, legacyMotor[2]!, args);
    if (operation.startsWith("Sensor.")) return this.sensor(operation.slice(7), args);
    const legacySensor = /^Sensor([1-4])\.Raw([13])$/.exec(operation);
    if (legacySensor) {
      const sensor = this.sensors[Number(legacySensor[1]) as PreviewSensorPort];
      if (sensor.busy) return { waitMs: 16, retry: true };
      return legacySensor[2] === "1"
        ? { value: sensor.raw[0] ?? 0 }
        : { writes: { 0: sensor.raw[0] ?? 0, 1: sensor.raw[1] ?? 0, 2: sensor.raw[2] ?? 0 } };
    }
    if (operation.startsWith("EV3File.")) return this.file(operation.slice(8), args);
    if (operation.startsWith("Speaker.")) return this.sound(operation.slice(8), args);
    switch (operation) {
      case "EV3.Time":
        return { value: Math.trunc(this.nowMs) };
      case "EV3.BatteryLevel":
        return { value: this.batteryLevel };
      case "EV3.BatteryVoltage":
        return { value: this.batteryVoltage };
      case "EV3.BatteryCurrent":
        return { value: this.batteryCurrent };
      case "EV3.BrickName":
        return { value: "Kobrixa Preview" };
      case "EV3.SetLEDColor":
        this.led = { color: String(args[0]).toLowerCase(), effect: String(args[1]).toLowerCase() };
        this.event(operation, `${this.led.color} / ${this.led.effect}`);
        return {};
      case "EV3.QueueNextCommand":
        return {};
      case "Program.Delay":
        return { waitMs: Math.max(0, integer(args[0])) };
      case "Program.End":
        return { end: true };
      case "Program.Directory":
        return { value: this.directory };
      case "Program.ArgumentCount":
        return { value: 0 };
      case "Program.GetArgument":
        return { value: "" };
      case "Buttons.Current":
        return { value: this.buttonText(this.buttons) };
      case "Buttons.GetClicks": {
        const value = this.buttonText(this.clicks);
        this.clicks.clear();
        return { value };
      }
      case "Buttons.Flush":
        this.clicks.clear();
        return {};
      case "Buttons.Wait":
        return this.buttons.size > 0 || this.clicks.size > 0 ? {} : { retry: true, waitMs: 16 };
      case "Button.IsPressed": {
        const name = String(args[0]).toLowerCase();
        const aliases: Record<string, PreviewButton> = {
          u: "up",
          d: "down",
          l: "left",
          r: "right",
          e: "enter",
          b: "back",
          center: "enter",
        };
        return {
          value:
            name === "any"
              ? this.buttons.size > 0
              : this.buttons.has(aliases[name] ?? (name as PreviewButton)),
        };
      }
      default:
        throw new Error(
          `${operation} is unavailable in offline preview. Physical buses, networking and system commands require an EV3.`,
        );
    }
  }

  protected event(operation: string, detail: string): void {
    this.events.push({
      id: this.nextEventId++,
      timeMs: this.nowMs,
      operation,
      detail: detail.slice(0, 256),
    });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }
  private buttonText(buttons: Set<PreviewButton>): string {
    return BUTTONS.slice(0, 5)
      .map((button, index) => (buttons.has(button) ? BUTTON_LETTERS[index] : ""))
      .join("");
  }
  private pixel(x: number, y: number, color: number): void {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) this.backBuffer[y * WIDTH + x] = color ? 1 : 0;
  }
  private rect(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
    fill: boolean,
    inverse = false,
  ): void {
    for (let py = Math.max(0, y); py < Math.min(HEIGHT, y + height); py++) {
      for (let px = Math.max(0, x); px < Math.min(WIDTH, x + width); px++) {
        if (fill || py === y || py === y + height - 1 || px === x || px === x + width - 1) {
          this.pixel(px, py, inverse ? 1 - this.backBuffer[py * WIDTH + px]! : color);
        }
      }
    }
  }
  private text(color: number, x: number, y: number, font: number, value: string): void {
    const [cellWidth, cellHeight] = font === 1 ? [16, 16] : font === 2 ? [6, 8] : [8, 9];
    for (const character of value.slice(0, 1024)) {
      if (character === "\n") {
        y += cellHeight;
        x = 0;
        continue;
      }
      const rows = (GLYPHS[character] ?? GLYPHS["?"]!).split("/");
      for (let py = 0; py < cellHeight - 1; py++) {
        for (let px = 0; px < cellWidth - 1; px++) {
          if (
            rows[Math.floor((py * 7) / (cellHeight - 1))]?.[
              Math.floor((px * 5) / (cellWidth - 1))
            ] === "1"
          )
            this.pixel(x + px, y + py, color);
        }
      }
      x += cellWidth;
    }
  }
  private display(operation: string, args: PreviewValue[]): PreviewInvokeResult {
    const n = (index: number) => integer(args[index]);
    const color = n(0) ? 1 : 0;
    switch (operation) {
      case "LCD.Clear":
        this.backBuffer.fill(0);
        break;
      case "LCD.StopUpdate":
        this.autoUpdate = false;
        return {};
      case "LCD.Update":
        this.autoUpdate = true;
        break;
      case "LCD.Pixel":
        this.pixel(n(1), n(2), color);
        break;
      case "LCD.FillRect":
      case "LCD.Rect":
        this.rect(n(1), n(2), n(3), n(4), color, operation === "LCD.FillRect");
        break;
      case "LCD.InverseRect":
        this.rect(n(0), n(1), n(2), n(3), 0, true, true);
        break;
      case "LCD.Line": {
        const x1 = n(1),
          y1 = n(2),
          x2 = n(3),
          y2 = n(4);
        const dx = x2 - x1,
          dy = y2 - y1;
        // Scan only visible coordinates: even huge offscreen lines remain bounded.
        if (Math.abs(dx) >= Math.abs(dy)) {
          if (dx === 0) this.pixel(x1, y1, color);
          else
            for (
              let x = Math.max(0, Math.min(x1, x2));
              x <= Math.min(WIDTH - 1, Math.max(x1, x2));
              x++
            )
              this.pixel(x, Math.round(y1 + ((x - x1) * dy) / dx), color);
        } else {
          for (
            let y = Math.max(0, Math.min(y1, y2));
            y <= Math.min(HEIGHT - 1, Math.max(y1, y2));
            y++
          )
            this.pixel(Math.round(x1 + ((y - y1) * dx) / dy), y, color);
        }
        break;
      }
      case "LCD.Circle":
      case "LCD.FillCircle": {
        const cx = n(1),
          cy = n(2),
          radius = Math.max(0, n(3));
        for (let y = 0; y < HEIGHT; y++)
          for (let x = 0; x < WIDTH; x++) {
            const distance = Math.hypot(x - cx, y - cy);
            if (
              operation === "LCD.FillCircle"
                ? distance <= radius
                : Math.abs(distance - radius) < 0.5
            )
              this.pixel(x, y, color);
          }
        break;
      }
      case "LCD.Text":
        this.font = bounded(n(3), 0, 2);
        this.text(color, n(1), n(2), this.font, String(args[4] ?? ""));
        this.event(operation, String(args[4] ?? ""));
        break;
      case "LCD.Write":
        this.text(1, n(0), n(1), this.font, String(args[2] ?? ""));
        this.event(operation, String(args[2] ?? ""));
        break;
      case "LCD.Value": {
        const text = numeric(args[3])
          .toFixed(bounded(n(5), 0, 20))
          .padStart(bounded(n(4), 0, 127), " ");
        this.text(color, n(1), n(2), this.font, text);
        this.event(operation, text);
        break;
      }
      case "LCD.BmpFile": {
        const name = String(args[3]);
        const bitmap = this.files.get(this.path(`${name}.rgf`));
        if (!bitmap)
          throw new Error(`Preview resource unavailable: ${name}. Add it to project resources.`);
        const width = bitmap[0] ?? 0,
          height = bitmap[1] ?? 0,
          stride = Math.ceil(width / 8);
        if (bitmap.length < 2 + stride * height)
          throw new Error(`Invalid RGF preview resource: ${name}.`);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            if ((bitmap[2 + y * stride + Math.floor(x / 8)]! & (1 << (x % 8))) !== 0)
              this.pixel(n(1) + x, n(2) + y, color);
          }
        this.event(operation, name);
        break;
      }
      default:
        throw new Error(`${operation} is unavailable in offline preview.`);
    }
    if (this.autoUpdate) {
      this.frontBuffer.set(this.backBuffer);
      this.revision++;
    }
    return {};
  }

  private selected(value: PreviewValue | undefined): MotorState[] {
    const text = String(value).toUpperCase();
    if (!/^[ABCD]+$/.test(text))
      throw new Error(`Preview supports local motor ports A–D; received '${text}'.`);
    return PORTS.filter((port) => text.includes(port)).map((port) => this.motors[port]);
  }
  private motor(method: string, args: PreviewValue[]): PreviewInvokeResult {
    const selected = this.selected(args[0]);
    const single = selected.at(-1)!;
    switch (method) {
      case "GetCount":
        return { value: Math.trunc(single.count) };
      case "GetSpeed":
        return { value: Math.trunc(single.speed) };
      case "IsBusy":
        return { value: selected.some((motor) => motor.busy) };
      case "Wait":
        return selected.some((motor) => motor.busy) ? { waitMs: 16, retry: true } : {};
      case "ResetCount":
        for (const motor of selected) motor.count = 0;
        break;
      case "Invert":
        for (const motor of selected) {
          motor.polarity *= -1;
          motor.speed *= -1;
        }
        break;
      case "Stop":
        for (const motor of selected) {
          motor.speed = 0;
          motor.busy = false;
          motor.remaining = null;
          motor.brake = Boolean(args[1]);
        }
        break;
      default: {
        const allowed = [
          "Start",
          "StartPower",
          "StartSteer",
          "StartSync",
          "Move",
          "MovePower",
          "Schedule",
          "SchedulePower",
          "ScheduleSteer",
          "MoveSteer",
          "ScheduleSync",
          "MoveSync",
        ];
        if (!allowed.includes(method))
          throw new Error(`Motor.${method} is unavailable in offline preview.`);
        const sync = method.endsWith("Sync"),
          steer = method.endsWith("Steer"),
          schedule = method === "Schedule" || method === "SchedulePower";
        if ((sync || steer) && selected.length !== 2)
          throw new Error(`Motor.${method} requires two preview motor ports.`);
        let speeds = selected.map(() => bounded(integer(args[1]), -100, 100));
        if (sync)
          speeds = [bounded(integer(args[1]), -100, 100), bounded(integer(args[2]), -100, 100)];
        if (steer) {
          const turn = bounded(integer(args[2]), -200, 200);
          speeds = [
            speeds[0]! * (turn < 0 ? 1 + turn / 100 : 1),
            speeds[0]! * (turn > 0 ? 1 - turn / 100 : 1),
          ];
        }
        const degrees = method.startsWith("Start")
          ? 0
          : Math.max(
              0,
              schedule
                ? integer(args[2]) + integer(args[3]) + integer(args[4])
                : integer(args[sync || steer ? 3 : 2]),
            );
        const maxSpeed = Math.max(...speeds.map(Math.abs));
        const duration = degrees && maxSpeed ? (degrees / (maxSpeed * 7.2)) * 1000 : 0;
        const brake = Boolean(args[schedule ? 5 : sync || steer ? 4 : 3]);
        for (const [index, motor] of selected.entries()) {
          motor.setting = speeds[index]!;
          motor.speed = motor.setting * motor.polarity;
          motor.busy = motor.speed !== 0;
          motor.remaining = degrees ? (degrees * Math.abs(motor.setting)) / (maxSpeed || 1) : null;
          motor.brake = brake;
        }
        this.event(
          `Motor.${method}`,
          `${String(args[0])}: ${speeds.join(" / ")}%${degrees ? `, ${degrees}°` : ""}`,
        );
        if (method.startsWith("Move") && duration) return { waitMs: Math.ceil(duration) };
        return {};
      }
    }
    this.event(`Motor.${method}`, String(args[0]));
    return {};
  }
  private legacyMotor(ports: string, method: string, args: PreviewValue[]): PreviewInvokeResult {
    const mapped: Record<string, string> = {
      Off: "Stop",
      OffAndBrake: "Stop",
      StartSpeed: "Start",
      StartPower: "StartPower",
      GetTacho: "GetCount",
      GetSpeed: "GetSpeed",
      ResetCount: "ResetCount",
    };
    if (mapped[method])
      return this.motor(mapped[method], [
        ports,
        ...(method === "Off" || method === "OffAndBrake" ? [method === "OffAndBrake"] : args),
      ]);
    const motors = this.selected(ports);
    for (const motor of motors) {
      if (method === "SetSpeed" || method === "SetPower") {
        motor.setting = bounded(integer(args[0]), -100, 100);
        if (motor.busy) motor.speed = motor.setting * motor.polarity;
      } else if (method === "Start") {
        motor.speed = motor.setting * motor.polarity;
        motor.busy = motor.speed !== 0;
        motor.remaining = null;
      } else if (method === "SetDirectPolarity" || method === "SetReversPolarity") {
        motor.polarity = method === "SetDirectPolarity" ? 1 : -1;
        if (motor.busy) motor.speed = motor.setting * motor.polarity;
      } else if (method !== "IsLarge" && method !== "IsMedium")
        throw new Error(`Motor${ports}.${method} is unavailable in offline preview.`);
    }
    this.event(`Motor${ports}.${method}`, args.join(", "));
    return {};
  }
  private sensor(method: string, args: PreviewValue[]): PreviewInvokeResult {
    if (method === "ReadSIValue") {
      // Match the backend's nonblocking SI contract before narrowing either argument.
      const port = Number(args[0]);
      const index = Number(args[1]);
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 16 ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 7
      )
        return { value: NaN };
      if (port > 4) throw new Error(`Preview supports sensor ports 1–4; received ${port}.`);
      const sensor = this.sensors[port as PreviewSensorPort];
      if (sensor.busy || sensor.type < 1 || sensor.type > 124 || sensor.mode < 0 || sensor.mode > 7)
        return { value: NaN };
      const value = Math.fround(sensor.si[index] ?? NaN);
      return { value: Number.isFinite(value) ? value : NaN };
    }
    const port = integer(args[0]);
    if (!SENSOR_PORTS.includes(port as PreviewSensorPort))
      throw new Error(`Preview supports sensor ports 1–4; received ${port}.`);
    const sensor = this.sensors[port as PreviewSensorPort];
    const channel = () => integer(args[1]);
    switch (method) {
      case "GetName":
        return { value: sensor.name };
      case "GetType":
        return { value: sensor.type };
      case "GetMode":
        return { value: sensor.mode };
      case "IsBusy":
        return { value: sensor.busy };
      case "Wait":
        return sensor.busy ? { retry: true, waitMs: 16 } : {};
      case "SetMode":
        sensor.mode = integer(args[1]);
        this.event("Sensor.SetMode", `${port}: ${sensor.mode}`);
        return {};
      case "ReadPercent":
        return { value: sensor.percent };
      case "ReadRawValue":
        return { value: sensor.raw[channel()] ?? 0 };
      case "ReadRaw":
        return {
          value: Array.from({ length: arrayLength(args[1]) }, (_, index) => sensor.raw[index] ?? 0),
        };
      default:
        throw new Error(
          `Sensor.${method} requires a physical sensor bus and is unavailable in offline preview.`,
        );
    }
  }
  private sound(method: string, args: PreviewValue[]): PreviewInvokeResult {
    if (method === "IsBusy") return { value: this.speaker.until > this.nowMs };
    if (method === "Wait") return { waitMs: Math.max(0, this.speaker.until - this.nowMs) };
    if (method === "Stop") this.speaker.until = this.nowMs;
    else {
      let duration: number;
      let frequency = 0;
      if (method === "Tone") {
        frequency = bounded(integer(args[1]), 0, 20000);
        duration = Math.max(0, integer(args[2]));
      } else if (method === "Note") {
        const note = /^([A-G])(#?)([0-8])$/i.exec(String(args[1]));
        if (!note) throw new Error(`Invalid preview musical note '${String(args[1])}'.`);
        const semitone = "C D EF G A B".indexOf(note[1]!.toUpperCase()) + (note[2] ? 1 : 0);
        const midi = (Number(note[3]) + 1) * 12 + semitone;
        frequency = Math.round(440 * 2 ** ((midi - 69) / 12));
        duration = Math.max(0, integer(args[2]));
      } else if (method === "Play") {
        const name = String(args[1]);
        const bytes = this.files.get(this.path(`${name}.rsf`));
        if (!bytes || bytes.length < 8)
          throw new Error(`Preview sound resource unavailable: ${name}.`);
        const format = bytes[0]! * 256 + bytes[1]!;
        const size = bytes[2]! * 256 + bytes[3]!;
        const rate = bytes[4]! * 256 + bytes[5]!;
        if (format !== 256 || rate === 0 || size > bytes.length - 8)
          throw new Error(`Unsupported preview sound format: ${name}. Only PCM RSF is supported.`);
        duration = (size / rate) * 1000;
      } else throw new Error(`Speaker.${method} is unavailable in offline preview.`);
      this.speaker = {
        frequency,
        volume: bounded(integer(args[0]), 0, 100),
        until: this.nowMs + duration,
      };
    }
    this.event(`Speaker.${method}`, args.join(", "));
    return {};
  }
  private path(value: string): string {
    // This is an in-memory namespace, never a host filesystem path.
    const absolute = value.startsWith("/") ? value : `${this.directory}/${value}`;
    const segments: string[] = [];
    for (const segment of absolute.replaceAll("\\", "/").split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === ".." && segments.length && segments.at(-1) !== "..") segments.pop();
      else segments.push(segment);
    }
    return `${absolute.startsWith("/") ? "/" : ""}${segments.join("/")}`;
  }
  private storeFile(path: string, bytes: number[]): void {
    if (!this.files.has(path) && this.files.size >= MAX_FILES)
      throw new Error(`Preview file limit is ${MAX_FILES}.`);
    const total = [...this.files].reduce(
      (sum, [name, data]) => sum + (name === path ? 0 : data.length),
      bytes.length,
    );
    if (total > MAX_FILE_BYTES) throw new Error("Preview files exceeded the 1 MiB memory limit.");
    this.files.set(path, bytes);
  }
  private file(method: string, args: PreviewValue[]): PreviewInvokeResult {
    if (method === "ConvertToNumber")
      return { value: Math.fround(Number.parseFloat(String(args[0])) || 0) };
    if (method === "TableLookup") {
      const bytes = this.files.get(this.path(String(args[0])));
      if (!bytes) throw new Error(`Preview file does not exist: ${String(args[0])}.`);
      const index = integer(args[1]) * integer(args[2]) + integer(args[3]);
      return { value: bytes[index] ?? 0 };
    }
    if (method === "OpenRead" || method === "OpenWrite" || method === "OpenAppend") {
      const path = this.path(String(args[0]));
      if (method === "OpenRead" && !this.files.has(path))
        throw new Error(`Preview file does not exist: ${String(args[0])}.`);
      if (this.handles.size >= MAX_FILES)
        throw new Error("Preview has too many open file handles.");
      if (method === "OpenWrite" || !this.files.has(path)) this.storeFile(path, []);
      const handle = this.nextHandle++;
      this.handles.set(handle, {
        path,
        offset: method === "OpenAppend" ? this.files.get(path)!.length : 0,
        writable: method !== "OpenRead",
      });
      this.event(`EV3File.${method}`, String(args[0]));
      return { value: handle };
    }
    const handleId = integer(args[0]);
    const handle = this.handles.get(handleId);
    if (!handle) throw new Error(`Invalid preview file handle ${handleId}.`);
    if (method === "Close") {
      this.handles.delete(handleId);
      return {};
    }
    const bytes = this.files.get(handle.path)!;
    if (method === "ReadByte") return { value: bytes[handle.offset++] ?? 0 };
    if (method === "ReadLine") {
      const line: number[] = [];
      while (handle.offset < bytes.length && line.length < 63) {
        const byte = bytes[handle.offset++]!;
        if (byte === 10) break;
        if (byte !== 13) line.push(byte);
      }
      return { value: new TextDecoder().decode(new Uint8Array(line)) };
    }
    if (method === "ReadNumberArray") {
      const count = arrayLength(args[1]);
      const result: number[] = [];
      const data = new DataView(
        new Uint8Array(bytes.slice(handle.offset, handle.offset + count * 4)).buffer,
      );
      for (let index = 0; index < count; index++)
        result.push(index * 4 + 4 <= data.byteLength ? data.getFloat32(index * 4, true) : 0);
      handle.offset += count * 4;
      return { value: result };
    }
    if (!handle.writable) throw new Error(`Preview file handle ${handleId} is read-only.`);
    let data: number[];
    if (method === "WriteByte") data = [integer(args[1]) & 255];
    else if (method === "WriteLine")
      data = Array.from(new TextEncoder().encode(`${String(args[1])}\n`));
    else if (method === "WriteNumberArray") {
      const count = arrayLength(args[1]);
      const values = args[2];
      if (!Array.isArray(values))
        throw new Error("EV3File.WriteNumberArray requires a preview array.");
      const buffer = new ArrayBuffer(count * 4);
      const view = new DataView(buffer);
      for (let index = 0; index < count; index++)
        view.setFloat32(index * 4, numeric(values[index]), true);
      data = Array.from(new Uint8Array(buffer));
    } else throw new Error(`EV3File.${method} is unavailable in offline preview.`);
    const updated = bytes.slice();
    if (handle.offset + data.length > MAX_FILE_BYTES)
      throw new Error("Preview file exceeded the 1 MiB memory limit.");
    while (updated.length < handle.offset) updated.push(0);
    for (const byte of data) updated[handle.offset++] = byte;
    this.storeFile(handle.path, updated);
    this.event(`EV3File.${method}`, `${handle.path}: ${data.length} bytes`);
    return {};
  }
}
