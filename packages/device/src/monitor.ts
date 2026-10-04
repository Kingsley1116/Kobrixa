import type { Ev3Connection } from "./contracts.js";
import type { DeviceInputModes, DeviceMonitorSnapshot, MonitorPortState } from "./monitor-types.js";
import { DeviceOperationError, withTimeout } from "./errors.js";
import { setTimeout as delay } from "node:timers/promises";

// Stock LEGO firmware: c_input.c, c_output.c, c_ui.c and bytecodes.h.
// Keep monitoring in CMD_SLOT and never use INPUT_READY/READY_SI: those wait
// inside the VM and may take ownership of a sensor used by USER_SLOT.
const INPUT_DEVICE = 0x99;
const INPUT_TEST = 0x9b;
const INPUT_READ_SI = 0x9d;
const INPUT_READ_EXT = 0x9e;
const TYPEMODE = 5;
const CONNECTION = 12;
const FORMAT = 2;
const NAME = 21;
const SYMBOL = 6;
const FIGURES = 24;
const MODENAME = 22;
const STOPPED = 0x40;
const NAME_BYTES = 16;
const SYMBOL_BYTES = 8;
const INPUT_BASE = 8;
const INPUT_STRIDE = 68;
const OUTPUT_BASE = INPUT_BASE + 4 * INPUT_STRIDE;
const OUTPUT_STRIDE = 24;
const SNAPSHOT_BYTES = OUTPUT_BASE + 4 * OUTPUT_STRIDE;
const EXCHANGE_TIMEOUT = 2000;

function lc(value: number): number[] {
  return value >= -32 && value <= 31 ? [value & 0x3f] : [0x81, value & 0xff];
}

function gv(offset: number): number[] {
  if (offset < 32) return [0x60 | offset];
  if (offset <= 255) return [0xe1, offset];
  return [0xe2, offset & 255, offset >> 8];
}

class Command {
  readonly code: number[] = [];

  constructor(readonly globals: number) {}

  add(...bytes: number[]): void {
    this.code.push(...bytes);
  }

  inputMetadata(port: number, offset: number): void {
    this.add(INPUT_DEVICE, TYPEMODE, 0, port, ...gv(offset), ...gv(offset + 1));
    this.add(INPUT_DEVICE, CONNECTION, 0, port, ...gv(offset + 2));
    this.add(INPUT_TEST, 0, port, ...gv(offset + 3));
    this.add(
      INPUT_DEVICE,
      FORMAT,
      0,
      port,
      ...gv(offset + 4),
      ...gv(offset + 5),
      ...gv(offset + 6),
      ...gv(offset + 7),
    );
  }

  program(offset: number): void {
    this.add(0x0c, 22, 1, ...gv(offset), 0x0c, 24, 1, ...gv(offset + 1));
  }

  payload(): Uint8Array {
    return Uint8Array.from([0, this.globals & 255, this.globals >> 8, ...this.code]);
  }
}

async function exchange(
  connection: Ev3Connection,
  command: Command,
  signal: AbortSignal,
  timeout = EXCHANGE_TIMEOUT,
): Promise<DataView> {
  const reply = await withTimeout(
    (bounded) => connection.exchange(command.payload(), bounded, timeout),
    signal,
    timeout,
  );
  if (reply[0] === 4) throw new DeviceOperationError("device", "EV3 rejected the monitor command.");
  if (reply[0] !== 2 || reply.length !== command.globals + 1)
    throw new DeviceOperationError("protocol", "Malformed EV3 monitor reply.");
  return new DataView(reply.buffer, reply.byteOffset + 1, command.globals);
}

function stringAt(data: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset + offset, length);
  const end = bytes.indexOf(0);
  if (end < 0) throw new DeviceOperationError("protocol", "Unterminated EV3 monitor name.");
  return new TextDecoder().decode(bytes.subarray(0, end)).trim();
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function portState(type: number, connection: number, busy: number): MonitorPortState {
  if (type === 126 || connection === 126) return "empty";
  if (type === 127 || connection === 127) return "error";
  if (type === 0 || type === 125 || type > 127) return "unknown";
  return busy ? "initializing" : "ready";
}

function officialInput(type: number, connection: number): boolean {
  return connection === 122 && [29, 30, 32, 33].includes(type);
}

interface InputMetadata {
  type: number;
  mode: number;
  connection: number;
  busy: number;
  datasets: number;
  modes: number;
  views: number;
}

function metadataAt(data: DataView, base: number): InputMetadata {
  const type = data.getUint8(base);
  const mode = data.getInt8(base + 1);
  const connection = data.getUint8(base + 2);
  const busy = data.getUint8(base + 3);
  const modes = data.getUint8(base + 6);
  const views = data.getUint8(base + 7);
  // Hot-plug and sensor initialization may expose sentinel metadata. These
  // describe one unavailable port, not a broken transport or malformed frame.
  return {
    type,
    mode,
    connection,
    busy,
    datasets: Math.min(8, data.getUint8(base + 4)),
    modes: modes <= 8 ? modes : 0,
    views: views <= 8 ? views : 0,
  };
}

function visibleModes(input: InputMetadata): number {
  // Firmware modes beyond Views include calibration and internal modes.
  return officialInput(input.type, input.connection) ? Math.min(input.modes, input.views) : 0;
}

function snapshotCommand(): Command {
  const command = new Command(SNAPSHOT_BYTES);
  command.program(0);
  command.add(0x81, 18, ...gv(2), 0x81, 1, ...gv(4));
  for (let port = 0; port < 4; port++) {
    const base = INPUT_BASE + port * INPUT_STRIDE;
    command.inputMetadata(port, base);
    command.add(INPUT_DEVICE, FIGURES, 0, port, ...gv(base + 8), ...gv(base + 9));
    command.add(INPUT_DEVICE, NAME, 0, port, NAME_BYTES, ...gv(base + 12));
    command.add(INPUT_DEVICE, SYMBOL, 0, port, SYMBOL_BYTES, ...gv(base + 28));
    command.add(INPUT_READ_EXT, 0, port, 0, ...lc(-1), 0x13, 8);
    for (let index = 0; index < 8; index++) command.add(...gv(base + 36 + index * 4));
    command.add(INPUT_DEVICE, TYPEMODE, 0, port, ...gv(base + 10), ...gv(base + 11));
  }
  for (let port = 0; port < 4; port++) {
    const base = OUTPUT_BASE + port * OUTPUT_STRIDE;
    command.add(INPUT_DEVICE, TYPEMODE, 0, port + 16, ...gv(base), ...gv(base + 1));
    command.add(INPUT_DEVICE, CONNECTION, 0, port + 16, ...gv(base + 2));
    command.add(INPUT_TEST, 0, port + 16, ...gv(base + 3));
    command.add(INPUT_DEVICE, NAME, 0, port + 16, NAME_BYTES, ...gv(base + 4));
    command.add(0xb3, 0, port, ...gv(base + 20));
  }
  return command;
}

async function readSnapshot(
  connection: Ev3Connection,
  signal: AbortSignal,
  timeout = EXCHANGE_TIMEOUT,
): Promise<DeviceMonitorSnapshot> {
  const data = await exchange(connection, snapshotCommand(), signal, timeout);
  const rawStatus = data.getUint8(0);
  const percent = data.getUint8(2);
  const rawVoltage = data.getFloat32(4, true);
  const voltage = rawVoltage >= 0 ? finite(rawVoltage) : null;
  const snapshot: DeviceMonitorSnapshot = {
    sampledAt: Date.now(),
    battery: { percent: percent <= 100 ? percent : null, voltage },
    program: {
      status: rawStatus === STOPPED ? "stopped" : rawStatus === 16 ? "running" : "unknown",
      rawStatus,
      result: data.getUint8(1),
    },
    inputs: [],
    outputs: [],
  };
  for (let port = 0; port < 4; port++) {
    const base = INPUT_BASE + port * INPUT_STRIDE;
    const input = metadataAt(data, base);
    let state = portState(input.type, input.connection, input.busy);
    // A running user program may select another mode between VM instructions.
    // Do not label those values with metadata from the previous mode.
    if (
      state === "ready" &&
      (input.mode < 0 ||
        input.mode > 7 ||
        data.getUint8(base + 10) !== input.type ||
        data.getInt8(base + 11) !== input.mode)
    )
      state = "initializing";
    const values = Array.from({ length: input.datasets }, (_, index) =>
      state === "ready" ? finite(data.getFloat32(base + 36 + index * 4, true)) : null,
    );
    const name = stringAt(data, base + 12, NAME_BYTES);
    snapshot.inputs.push({
      port,
      type: input.type,
      connection: input.connection,
      mode: input.mode,
      state,
      name,
      modeName: name,
      unit: stringAt(data, base + 28, SYMBOL_BYTES),
      decimals: Math.min(data.getUint8(base + 9), 6),
      values,
      switchable: visibleModes(input) > 1 && state === "ready",
    });
  }
  for (let port = 0; port < 4; port++) {
    const base = OUTPUT_BASE + port * OUTPUT_STRIDE;
    const type = data.getUint8(base);
    const state = portState(type, data.getUint8(base + 2), data.getUint8(base + 3));
    const count = data.getInt32(base + 20, true);
    snapshot.outputs.push({
      port,
      type,
      state,
      name: stringAt(data, base + 4, NAME_BYTES),
      angle: state === "ready" && [7, 8].includes(type) && count !== -2147483648 ? count : null,
    });
  }
  return snapshot;
}

function validatePort(port: number, expectedType: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 3)
    throw new DeviceOperationError("device", "Monitor input port must be between 1 and 4.");
  if (!Number.isInteger(expectedType) || expectedType < 1 || expectedType > 127)
    throw new DeviceOperationError("device", "Invalid expected sensor type.");
}

function requireType(input: InputMetadata, expectedType: number): void {
  if (input.type !== expectedType)
    throw new DeviceOperationError("device", "The sensor changed. Refresh its modes.");
}

export async function readMonitor(
  connection: Ev3Connection,
  signal: AbortSignal,
  shouldYield: () => boolean = () => false,
): Promise<DeviceMonitorSnapshot | undefined> {
  signal.throwIfAborted();
  if (shouldYield()) return undefined;
  const result = await readSnapshot(connection, signal);
  return shouldYield() ? undefined : result;
}

export async function readInputModes(
  connection: Ev3Connection,
  port: number,
  expectedType: number,
  signal: AbortSignal,
  shouldYield: () => boolean = () => false,
): Promise<DeviceInputModes | undefined> {
  validatePort(port, expectedType);
  signal.throwIfAborted();
  if (shouldYield()) return undefined;
  const metadata = new Command(8);
  metadata.inputMetadata(port, 0);
  const input = metadataAt(await exchange(connection, metadata, signal), 0);
  if (shouldYield()) return undefined;
  requireType(input, expectedType);
  const count = visibleModes(input);
  if (!count) return { port, type: input.type, modes: [] };
  const command = new Command(4 + count * NAME_BYTES);
  command.add(INPUT_DEVICE, TYPEMODE, 0, port, ...gv(0), ...gv(1));
  for (let mode = 0; mode < count; mode++)
    command.add(INPUT_DEVICE, MODENAME, 0, port, mode, NAME_BYTES, ...gv(4 + mode * NAME_BYTES));
  command.add(INPUT_DEVICE, TYPEMODE, 0, port, ...gv(2), ...gv(3));
  const data = await exchange(connection, command, signal);
  if (shouldYield()) return undefined;
  if (data.getUint8(0) !== expectedType || data.getUint8(2) !== expectedType)
    throw new DeviceOperationError("device", "The sensor changed. Refresh its modes.");
  return {
    port,
    type: input.type,
    modes: Array.from({ length: count }, (_, mode) => ({
      mode,
      name: stringAt(data, 4 + mode * NAME_BYTES, NAME_BYTES) || `Mode ${mode}`,
    })),
  };
}

function modeCommand(port: number, expectedType: number, mode: number): Command {
  const command = new Command(16);
  // Return flag 0 unless every firmware-side guard succeeds. A separate host
  // status check would be stale if the brick started a program in the meantime.
  command.add(0x30, 0, ...gv(0));
  command.add(0x0c, 22, 1, ...gv(1));
  command.inputMetadata(port, 2);
  const jumps: number[] = [];
  const guard = (opcode: number, offset: number, value: number): void => {
    command.add(opcode, ...gv(offset), ...lc(value), 0x82, 0, 0);
    jumps.push(command.code.length - 2);
  };
  guard(0x70, 1, STOPPED); // JR_NEQ8
  guard(0x70, 2, expectedType);
  guard(0x70, 4, 122);
  guard(0x70, 5, 0); // INPUT_TEST: do not change a busy sensor.
  guard(0x74, 8, mode); // JR_LTEQ8: MODES and VIEWS must exceed requested mode.
  guard(0x74, 9, mode);
  command.add(INPUT_READ_SI, 0, port, 0, mode, ...gv(12));
  command.add(0x30, 1, ...gv(0));
  for (const position of jumps) {
    const offset = command.code.length - (position + 2);
    command.code[position] = offset & 255;
    command.code[position + 1] = offset >> 8;
  }
  return command;
}

export async function setInputMode(
  connection: Ev3Connection,
  port: number,
  expectedType: number,
  mode: number,
  signal: AbortSignal,
): Promise<DeviceMonitorSnapshot> {
  validatePort(port, expectedType);
  if (![29, 30, 32, 33].includes(expectedType) || !Number.isInteger(mode) || mode < 0 || mode > 7)
    throw new DeviceOperationError("device", "This sensor mode is not supported by the monitor.");
  const deadline = Date.now() + 5000;
  const data = await exchange(connection, modeCommand(port, expectedType, mode), signal);
  const input = metadataAt(data, 2);
  if (data.getUint8(0) !== 1) {
    if (data.getUint8(1) !== STOPPED)
      throw new DeviceOperationError("device", "Stop the EV3 program before changing sensor mode.");
    requireType(input, expectedType);
    throw new DeviceOperationError("device", "The sensor is busy or this mode is unavailable.");
  }
  // The command only requests the change. Read back the mode and readiness;
  // UART sensors can remain busy for over a second after switching modes.
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot(
      connection,
      signal,
      Math.min(EXCHANGE_TIMEOUT, Math.max(1, deadline - Date.now())),
    );
    const current = snapshot.inputs[port]!;
    if (current.type !== expectedType || current.state === "empty" || current.state === "error")
      throw new DeviceOperationError("device", "The sensor changed while switching modes.");
    if (current.mode === mode && current.state === "ready") return snapshot;
    if (snapshot.program.status !== "stopped")
      throw new DeviceOperationError("device", "The EV3 program started while switching modes.");
    await delay(Math.min(100, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw new DeviceOperationError(
    "device",
    "The sensor mode did not become ready within 5 seconds.",
  );
}
