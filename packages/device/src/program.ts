import type { Ev3Connection } from "./contracts.js";
import { DeviceOperationError, withTimeout } from "./errors.js";

const STOPPED = 0x40;
const RUNNING = 0x10;
const WAITING = 0x20;
const TIMEOUT = 5000;

async function exchange(
  connection: Ev3Connection,
  globals: number,
  code: number[],
  signal: AbortSignal,
): Promise<DataView> {
  const reply = await withTimeout(
    (bounded) => connection.exchange(Uint8Array.from([0, globals, 0, ...code]), bounded, TIMEOUT),
    signal,
    TIMEOUT,
  );
  if (reply[0] === 4)
    throw new DeviceOperationError("device", "EV3 rejected the program control command.");
  if (reply[0] !== 2 || reply.length !== globals + 1)
    throw new DeviceOperationError("protocol", "Malformed EV3 program control reply.");
  return new DataView(reply.buffer, reply.byteOffset + 1, globals);
}

export async function stopProgram(connection: Ev3Connection, signal: AbortSignal): Promise<void> {
  // Stop only USER_SLOT, then confirm it in the same direct command.
  const data = await exchange(connection, 1, [0x02, 1, 0x0c, 22, 1, 0x60], signal);
  if (data.getUint8(0) !== STOPPED)
    throw new DeviceOperationError(
      "device",
      "EV3 did not confirm that the previous program stopped.",
    );
}

export async function startProgram(
  connection: Ev3Connection,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  await stopProgram(connection, signal);
  // Firmware LOAD_IMAGE and PROGRAM_START silently skip occupied slots.
  // Check USER_SLOT and DEBUG_SLOT in the same command as load/start, and
  // return the loaded size/pointer plus status/result from this attempt.
  // Source: LEGO firmware c_memory.c LOAD_IMAGE and lms2012.c ProgramStart.
  const code = [0x0c, 22, 1, 0x68, 0x0c, 22, 4, 0x69];
  const exits: number[] = [];
  const guard = (opcode: number, ...operands: number[]): void => {
    code.push(opcode, ...operands, 0x82, 0, 0);
    exits.push(code.length - 2);
  };
  guard(0x70, 0x68, 0x81, STOPPED); // JR_NEQ8 user status
  guard(0x70, 0x69, 0x81, STOPPED); // JR_NEQ8 debug status
  code.push(0xc0, 8, 1, 0x84, ...new TextEncoder().encode(target), 0, 0x60, 0x64);
  guard(0x76, 0x60, 0); // JR_LTEQ32 image size
  guard(0x6e, 0x64, 0); // JR_EQ32 image pointer (addresses are unsigned)
  code.push(0x03, 1, 0x60, 0x64, 0, 0x0c, 22, 1, 0x6a, 0x0c, 24, 1, 0x6b);
  for (const position of exits) {
    const distance = code.length - (position + 2);
    code[position] = distance & 255;
    code[position + 1] = distance >> 8;
  }
  const data = await exchange(connection, 12, code, signal);
  if (data.getUint8(8) !== STOPPED || data.getUint8(9) !== STOPPED)
    throw new DeviceOperationError(
      "device",
      "EV3 program slot is busy; the new program was not started.",
    );
  if (data.getInt32(0, true) <= 0 || data.getUint32(4, true) === 0)
    throw new DeviceOperationError("device", "EV3 could not load the uploaded program.");
  const status = data.getUint8(10),
    result = data.getUint8(11);
  // These snapshots immediately follow PROGRAM_START in the same non-yielding
  // direct command. A short program can finish before the reply reaches us.
  // A later STOPPED/OK poll is not proof of startup: it could describe the old
  // program that we just stopped while PROGRAM_START was silently skipped.
  if ((status === RUNNING || status === WAITING) && result === 1) return;
  throw new DeviceOperationError(
    "device",
    `EV3 did not confirm program startup (status ${status}, result ${result}).`,
  );
}
