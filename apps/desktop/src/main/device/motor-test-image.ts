import { createRbf, gv, INPUT_DEVICE, lc, lv, OP, relativeOffset } from "@kobrixa/backend-ev3";
import { MOTOR_HELPER } from "@kobrixa/device";

export interface MotorTestImageOptions {
  token: number;
  port: number;
  /** Signed, unregulated power. Zero is not a movement request. */
  power: number;
  angle: number;
  brake: boolean;
}

const ARM_TIMEOUT_MS = 2_000;
const MOVEMENT_TIMEOUT_MS = 10_000;
const RESULT_GRACE_MS = 2_000;
const POLL_MS = 10;
const LOCAL = {
  started: 0,
  now: 4,
  elapsed: 8,
  timer: 12,
  condition: 16,
  busy: 17,
  type: 18,
  mode: 19,
};

/** Fixed-width relocations keep labels independent of EV3 constant compaction. */
class ImageCode {
  readonly bytes: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly jumps: Array<{ offset: number; label: string }> = [];

  add(opcode: number, ...parameters: number[][]): void {
    this.bytes.push(opcode, ...parameters.flat());
  }

  label(name: string): void {
    if (this.labels.has(name)) throw new Error(`Duplicate motor image label: ${name}`);
    this.labels.set(name, this.bytes.length);
  }

  jump(name: string, when?: boolean): void {
    this.add(
      when === undefined ? OP.JR : when ? OP.JR_TRUE : OP.JR_FALSE,
      ...(when === undefined ? [] : [lv(LOCAL.condition)]),
    );
    this.jumps.push({ offset: this.bytes.length, label: name });
    this.bytes.push(...relativeOffset(0));
  }

  finish(): Uint8Array {
    for (const jump of this.jumps) {
      const destination = this.labels.get(jump.label);
      if (destination === undefined) throw new Error(`Missing motor image label: ${jump.label}`);
      this.bytes.splice(jump.offset, 5, ...relativeOffset(destination - (jump.offset + 5)));
    }
    return Uint8Array.from(this.bytes);
  }
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`Invalid motor test ${name}.`);
}

/**
 * A project-independent, finite USER_SLOT program. Merely opening this image
 * cannot start a motor: a host must acknowledge this exact invocation's token.
 * No OUTPUT_READY or other unbounded device wait may be added to this program.
 */
export function createMotorTestImage(options: MotorTestImageOptions): Uint8Array {
  integerInRange(options.token, 1, 0x7fffffff, "token");
  integerInRange(options.port, 0, 3, "port");
  integerInRange(options.power, -100, 100, "power");
  if (options.power === 0) throw new RangeError("Invalid motor test power.");
  integerInRange(options.angle, 1, 3_600, "angle");
  if (typeof options.brake !== "boolean") throw new TypeError("Invalid motor test brake.");

  const code = new ImageCode();
  const mask = lc(1 << options.port);
  const port = lc(options.port);
  const layer = lc(0);
  const move32 = (value: number, destination: number) =>
    code.add(OP.MOVE_32_32, lc(value), gv(destination));
  const move8 = (value: number, destination: number) =>
    code.add(OP.MOVE_8_8, lc(value), gv(destination));
  const sleep = (duration: number) => {
    code.add(OP.TIMER_WAIT, lc(duration), lv(LOCAL.timer));
    code.add(OP.TIMER_READY, lv(LOCAL.timer));
  };
  const readAngle = () => code.add(OP.OUTPUT_GET_COUNT, layer, port, gv(MOTOR_HELPER.angleOffset));
  const deadline = (duration: number, expired: string) => {
    code.add(OP.TIMER_READ, lv(LOCAL.now));
    code.add(OP.SUB_32, lv(LOCAL.now), lv(LOCAL.started), lv(LOCAL.elapsed));
    code.add(OP.CP_GTEQ_32, lv(LOCAL.elapsed), lc(duration), lv(LOCAL.condition));
    code.jump(expired, true);
  };
  const validMotor = (invalid: string, valid: string) => {
    code.add(
      OP.INPUT_DEVICE,
      lc(INPUT_DEVICE.GET_TYPEMODE),
      layer,
      lc(16 + options.port),
      lv(LOCAL.type),
      lv(LOCAL.mode),
    );
    code.add(OP.CP_EQ_8, lv(LOCAL.type), lc(7), lv(LOCAL.condition));
    code.jump(valid, true);
    code.add(OP.CP_EQ_8, lv(LOCAL.type), lc(8), lv(LOCAL.condition));
    code.jump(invalid, false);
    code.label(valid);
  };

  // Publish identity last, after every field needed by the host is initialized.
  move32(options.token, MOTOR_HELPER.tokenOffset);
  move32(0, MOTOR_HELPER.armOffset);
  move8(MOTOR_HELPER.states.waiting, MOTOR_HELPER.stateOffset);
  move8(MOTOR_HELPER.results.none, MOTOR_HELPER.resultOffset);
  move8(options.port, MOTOR_HELPER.portOffset);
  readAngle();
  move32(MOTOR_HELPER.magic, MOTOR_HELPER.magicOffset);
  code.add(OP.TIMER_READ, lv(LOCAL.started));
  code.label("await-arm");
  // An acknowledgement arriving after the deadline must not revive the image.
  deadline(ARM_TIMEOUT_MS, "not-armed");
  code.add(OP.CP_EQ_32, gv(MOTOR_HELPER.armOffset), lc(options.token), lv(LOCAL.condition));
  code.jump("armed", true);
  sleep(POLL_MS);
  code.jump("await-arm");

  code.label("armed");
  validMotor("cancelled", "motor-ready");
  code.add(OP.TIMER_READ, lv(LOCAL.started));
  move8(MOTOR_HELPER.states.running, MOTOR_HELPER.stateOffset);
  code.add(
    OP.OUTPUT_STEP_POWER,
    layer,
    mask,
    lc(options.power),
    lc(0),
    lc(options.angle),
    lc(0),
    lc(Number(options.brake)),
  );
  code.label("running");
  sleep(POLL_MS);
  deadline(MOVEMENT_TIMEOUT_MS, "timed-out");
  code.add(OP.CP_EQ_32, gv(MOTOR_HELPER.armOffset), lc(options.token), lv(LOCAL.condition));
  code.jump("cancelled", false);
  validMotor("cancelled", "motor-still-present");
  readAngle();
  code.add(OP.OUTPUT_TEST, layer, mask, lv(LOCAL.busy));
  code.add(OP.CP_EQ_8, lv(LOCAL.busy), lc(0), lv(LOCAL.condition));
  code.jump("running", false);

  code.add(OP.OUTPUT_STOP, layer, mask, lc(Number(options.brake)));
  move8(MOTOR_HELPER.results.complete, MOTOR_HELPER.resultOffset);
  code.jump("finished");
  code.label("timed-out");
  move8(MOTOR_HELPER.results.timeout, MOTOR_HELPER.resultOffset);
  code.jump("brake");
  code.label("cancelled");
  move8(MOTOR_HELPER.results.cancelled, MOTOR_HELPER.resultOffset);
  code.label("brake");
  code.add(OP.OUTPUT_STOP, layer, mask, lc(1));
  code.jump("finished");

  code.label("not-armed");
  move8(MOTOR_HELPER.results.notArmed, MOTOR_HELPER.resultOffset);
  // An unarmed stale image must not emit motor-control instructions at all.
  code.label("finished");
  readAngle();
  move8(MOTOR_HELPER.states.finished, MOTOR_HELPER.stateOffset);
  sleep(RESULT_GRACE_MS);
  code.add(OP.OBJECT_END);

  return createRbf(
    [{ ownerObjectId: 0, triggerCount: 0, localBytes: 20, code: code.finish() }],
    MOTOR_HELPER.globalBytes,
  );
}
