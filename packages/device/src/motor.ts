import type { Ev3Connection } from "./contracts.js";
import { DeviceOperationError, withTimeout } from "./errors.js";
import { MOTOR_HELPER, type MotorHelperStatus, type MotorTestReading } from "./motor-types.js";
import { normalizeRemotePath } from "./path.js";

// Stock LEGO firmware: lms2012.c and c_output.c. OUTPUT_TEST takes a mask;
// OUTPUT_READ/GET_COUNT take a port. OUTPUT_READ's tacho is not the persistent
// sensor count, so sample GET_COUNT separately without ever clearing it.
const STOPPED = 0x40;
const RUNNING = 0x10;
const TIMEOUT = 2000;
const HELPER_BASE = 4;

function lc(value: number): number[] {
  if (value >= -32 && value <= 31) return [value & 0x3f];
  if (value >= -128 && value <= 127) return [0x81, value & 255];
  if (value >= -32768 && value <= 32767) return [0x82, value & 255, (value >> 8) & 255];
  return [0x83, value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255];
}

function gv(offset: number): number[] {
  return offset < 32 ? [0x60 | offset] : [0xe1, offset];
}

class Command {
  readonly code: number[] = [];
  readonly exits: number[] = [];

  constructor(readonly globals: number) {}

  add(...bytes: number[]): void {
    this.code.push(...bytes);
  }

  guard(opcode: number, offset: number, value: number): void {
    this.add(opcode, ...gv(offset), ...lc(value), 0x82, 0, 0);
    this.exits.push(this.code.length - 2);
  }

  payload(): Uint8Array {
    for (const position of this.exits) {
      const offset = this.code.length - (position + 2);
      this.code[position] = offset & 255;
      this.code[position + 1] = offset >> 8;
    }
    return Uint8Array.from([0, this.globals & 255, this.globals >> 8, ...this.code]);
  }
}

async function exchange(
  connection: Ev3Connection,
  command: Command,
  signal: AbortSignal,
): Promise<DataView> {
  signal.throwIfAborted();
  const reply = await withTimeout(
    (bounded) => connection.exchange(command.payload(), bounded, TIMEOUT),
    signal,
    TIMEOUT,
  );
  if (reply[0] === 4)
    throw new DeviceOperationError("device", "EV3 rejected the motor test command.");
  if (reply[0] !== 2 || reply.length !== command.globals + 1)
    throw new DeviceOperationError("protocol", "Malformed EV3 motor test reply.");
  return new DataView(reply.buffer, reply.byteOffset + 1, command.globals);
}

function portNumber(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 3)
    throw new DeviceOperationError("device", "Motor test port must be A–D.");
}

function brakeValue(brake: boolean): void {
  if (typeof brake !== "boolean")
    throw new DeviceOperationError("device", "Invalid motor stopping mode.");
}

function helperToken(token: number): void {
  if (!Number.isInteger(token) || token < 1 || token > 0x7fffffff)
    throw new DeviceOperationError("device", "Invalid motor test identity.");
}

function requireAccepted(data: DataView, message: string): void {
  const accepted = data.getUint8(0);
  if (accepted > 1)
    throw new DeviceOperationError("protocol", "Invalid motor test acknowledgement.");
  if (!accepted) throw new DeviceOperationError("device", message);
}

function stoppedGuard(command: Command): void {
  command.add(0x30, 0, ...gv(0), 0x0c, 22, 1, ...gv(1));
  command.guard(0x70, 1, STOPPED); // JR_NEQ8
}

export async function readMotorTest(
  connection: Ev3Connection,
  signal: AbortSignal,
): Promise<MotorTestReading> {
  const command = new Command(68);
  command.add(0x0c, 22, 1, ...gv(0));
  for (let port = 0; port < 4; port++) {
    const base = 4 + port * 16;
    command.add(0x99, 5, 0, port + 16, ...gv(base), ...gv(base + 1));
    command.add(0x9b, 0, port + 16, ...gv(base + 2));
    command.add(0xa9, 0, 1 << port, ...gv(base + 3));
    command.add(0xa8, 0, port, ...gv(base + 4), ...gv(base + 8));
    command.add(0xb3, 0, port, ...gv(base + 12));
  }
  const data = await exchange(connection, command, signal);
  return {
    sampledAt: Date.now(),
    programStopped: data.getUint8(0) === STOPPED,
    outputs: Array.from({ length: 4 }, (_, port) => {
      const base = 4 + port * 16;
      const type = data.getUint8(base),
        inputBusy = data.getUint8(base + 2),
        busy = data.getUint8(base + 3);
      if (inputBusy > 1 || busy > 1)
        throw new DeviceOperationError("protocol", "Invalid motor readiness reply.");
      const angle = data.getInt32(base + 12, true),
        speed = data.getInt8(base + 4);
      return {
        port,
        type,
        busy: busy !== 0,
        speed: Math.abs(speed) <= 100 ? speed : null,
        angle: [7, 8].includes(type) && !inputBusy && angle !== -2147483648 ? angle : null,
      };
    }),
  };
}

export async function motorTimed(
  connection: Ev3Connection,
  port: number,
  power: number,
  durationMs: number,
  brake: boolean,
  signal: AbortSignal,
): Promise<void> {
  portNumber(port);
  brakeValue(brake);
  if (
    !Number.isInteger(power) ||
    power === 0 ||
    Math.abs(power) > 100 ||
    !Number.isInteger(durationMs) ||
    durationMs < 100 ||
    durationMs > 5000
  )
    throw new DeviceOperationError(
      "device",
      "Motor power must be 1–100% and duration 100–5000 ms.",
    );
  const command = new Command(5);
  stoppedGuard(command);
  command.add(0x99, 5, 0, port + 16, ...gv(2), ...gv(3));
  command.add(0x9b, 0, port + 16, ...gv(4));
  command.guard(0x64, 2, 7); // JR_LT8
  command.guard(0x68, 2, 8); // JR_GT8
  command.guard(0x70, 4, 0);
  command.add(0xad, 0, 1 << port, ...lc(power), 0, ...lc(durationMs), 0, brake ? 1 : 0);
  command.add(0x30, 1, ...gv(0));
  requireAccepted(
    await exchange(connection, command, signal),
    "Stop the EV3 program and connect a ready EV3 motor before testing.",
  );
}

export async function motorStop(
  connection: Ev3Connection,
  port: number,
  brake: boolean,
  signal: AbortSignal,
): Promise<void> {
  portNumber(port);
  brakeValue(brake);
  const command = new Command(2);
  stoppedGuard(command);
  command.add(0xa3, 0, 1 << port, brake ? 1 : 0, 0x30, 1, ...gv(0));
  requireAccepted(
    await exchange(connection, command, signal),
    "Another EV3 program is running; motor test stop was not applied.",
  );
}

/** The FILE load and PROGRAM_START share CMD_SLOT with the stopped guard. */
export async function runMotorHelper(
  connection: Ev3Connection,
  remotePath: string,
  signal: AbortSignal,
): Promise<void> {
  const target = normalizeRemotePath(remotePath);
  const command = new Command(12);
  stoppedGuard(command);
  command.add(0xc0, 8, 1, 0x84, ...new TextEncoder().encode(target), 0, ...gv(4), ...gv(8));
  command.add(0x03, 1, ...gv(4), ...gv(8), 0, 0x30, 1, ...gv(0));
  requireAccepted(
    await exchange(connection, command, signal),
    "Stop the EV3 program before starting a motor test.",
  );
}

function ownedHelperCommand(token: number): Command {
  helperToken(token);
  const command = new Command(HELPER_BASE + MOTOR_HELPER.globalBytes);
  command.add(0x30, 0, ...gv(0), 0x0c, 22, 1, ...gv(1));
  command.guard(0x70, 1, RUNNING);
  command.add(0x7f, 1, 0, 0, MOTOR_HELPER.globalBytes, ...gv(HELPER_BASE));
  command.guard(0x72, HELPER_BASE + MOTOR_HELPER.magicOffset, MOTOR_HELPER.magic); // JR_NEQ32
  command.guard(0x72, HELPER_BASE + MOTOR_HELPER.tokenOffset, token);
  return command;
}

export async function readMotorHelper(
  connection: Ev3Connection,
  token: number,
  signal: AbortSignal,
): Promise<MotorHelperStatus> {
  const command = ownedHelperCommand(token);
  command.add(0x30, 1, ...gv(0));
  const data = await exchange(connection, command, signal);
  if (data.getUint8(0) > 1)
    throw new DeviceOperationError("protocol", "Invalid motor helper acknowledgement.");
  if (!data.getUint8(0)) return { owned: false, state: 0, result: 0, angle: null };
  const state = data.getUint8(HELPER_BASE + MOTOR_HELPER.stateOffset);
  const result = data.getUint8(HELPER_BASE + MOTOR_HELPER.resultOffset);
  if (
    state > MOTOR_HELPER.states.finished ||
    result > MOTOR_HELPER.results.notArmed ||
    data.getUint8(HELPER_BASE + MOTOR_HELPER.portOffset) > 3
  )
    throw new DeviceOperationError("protocol", "Invalid motor helper result.");
  const angle = data.getInt32(HELPER_BASE + MOTOR_HELPER.angleOffset, true);
  return { owned: true, state, result, angle: angle === -2147483648 ? null : angle };
}

export async function armMotorHelper(
  connection: Ev3Connection,
  token: number,
  signal: AbortSignal,
): Promise<void> {
  const command = ownedHelperCommand(token);
  command.guard(0x70, HELPER_BASE + MOTOR_HELPER.stateOffset, MOTOR_HELPER.states.waiting);
  command.add(0x7e, 1, 0, MOTOR_HELPER.armOffset, 4, ...gv(HELPER_BASE + MOTOR_HELPER.tokenOffset));
  command.add(0x30, 1, ...gv(0));
  requireAccepted(
    await exchange(connection, command, signal),
    "The motor test helper is unavailable or its identity changed.",
  );
}

export async function stopMotorHelper(
  connection: Ev3Connection,
  token: number,
  port: number,
  brake: boolean,
  signal: AbortSignal,
): Promise<boolean> {
  portNumber(port);
  brakeValue(brake);
  const command = ownedHelperCommand(token);
  command.guard(0x70, HELPER_BASE + MOTOR_HELPER.portOffset, port);
  // PROGRAM_STOP affects all outputs; the caller must reserve the whole device.
  command.add(0x02, 1, 0xa3, 0, 1 << port, brake ? 1 : 0, 0x30, 1, ...gv(0));
  const data = await exchange(connection, command, signal);
  if (data.getUint8(0) > 1)
    throw new DeviceOperationError("protocol", "Invalid motor helper stop acknowledgement.");
  return data.getUint8(0) === 1;
}
