import { describe, expect, it } from "vitest";
import { inspectRbf } from "@kobrixa/backend-ev3";
import { MOTOR_HELPER } from "@kobrixa/device";
// The bytecode suite's deterministic VM is shared JavaScript test infrastructure.
// @ts-expect-error The test VM deliberately has no published TypeScript declarations.
import * as testVm from "../../../../../tests/bytecode/support/ev3-vm.mjs";
import { createMotorTestImage, type MotorTestImageOptions } from "./motor-test-image.js";

interface Parameter {
  n?: number;
  off?: number;
  scope?: string;
  t: string;
}
interface Instruction {
  name: string;
  args: Parameter[];
}
interface DecodedImage {
  objects: Array<{ ins: Instruction[]; local: number }>;
}
interface TestMachine {
  g: Buffer;
  time: number;
  execute(instruction: Instruction): void;
  read(parameter: Parameter): number;
  write(parameter: Parameter, value: number): void;
  run(): { status: string; error?: string };
}
const decode = testVm.decode as (image: Uint8Array) => DecodedImage;
const VM = testVm.VM as new (image: DecodedImage, scenario: Record<string, unknown>) => TestMachine;
const defaults: MotorTestImageOptions = {
  token: 194_267,
  port: 1,
  power: 20,
  angle: 90,
  brake: true,
};

interface Scenario {
  options?: Partial<MotorTestImageOptions>;
  armAt?: number | null;
  armToken?: number;
  cancelAt?: number;
  unplugAt?: number;
  motorType?: number;
  completeAfter?: number;
}

function simulate(scenario: Scenario = {}) {
  const options = { ...defaults, ...scenario.options };
  const vm = new VM(decode(createMotorTestImage(options)), { sensorType: scenario.motorType ?? 7 });
  const execute = vm.execute.bind(vm);
  const began = vm.time;
  let armed = false;
  let startedAt: number | undefined;
  let finishedAt: number | undefined;
  const controls: Array<{ name: string; at: number; args: number[] }> = [];
  const armAt = scenario.armAt === undefined ? 10 : scenario.armAt;
  vm.execute = (instruction) => {
    const elapsed = vm.time - began;
    if (
      !armed &&
      armAt !== null &&
      elapsed >= armAt &&
      vm.g.readInt32LE(MOTOR_HELPER.magicOffset) === MOTOR_HELPER.magic
    ) {
      vm.g.writeInt32LE(scenario.armToken ?? options.token, MOTOR_HELPER.armOffset);
      armed = true;
    }
    if (scenario.cancelAt !== undefined && elapsed >= scenario.cancelAt)
      vm.g.writeInt32LE(0, MOTOR_HELPER.armOffset);
    if (instruction.name === "OUTPUT_STEP_POWER") startedAt = elapsed;
    if (["OUTPUT_STEP_POWER", "OUTPUT_STOP"].includes(instruction.name))
      controls.push({
        name: instruction.name,
        at: elapsed,
        args: instruction.args.map((p) => vm.read(p)),
      });
    execute(instruction);
    if (instruction.name === "OUTPUT_TEST") {
      const busy = startedAt !== undefined && elapsed - startedAt < (scenario.completeAfter ?? 30);
      vm.write(instruction.args[2]!, Number(busy));
    }
    if (instruction.name === "OUTPUT_GET_COUNT")
      vm.write(instruction.args[2]!, 400 + (startedAt === undefined ? 0 : elapsed - startedAt));
    if (
      instruction.name === "INPUT_DEVICE.GET_TYPEMODE" &&
      scenario.unplugAt !== undefined &&
      elapsed >= scenario.unplugAt
    )
      vm.write(instruction.args[3]!, 126);
    if (finishedAt === undefined && vm.g[MOTOR_HELPER.stateOffset] === MOTOR_HELPER.states.finished)
      finishedAt = elapsed;
  };
  const result = vm.run();
  expect(result, result.error).toMatchObject({ status: "ended" });
  return {
    controls,
    startedAt,
    finishedAt,
    endedAt: vm.time - began,
    globals: vm.g,
    state: vm.g[MOTOR_HELPER.stateOffset],
    result: vm.g[MOTOR_HELPER.resultOffset],
  };
}

describe("finite angle motor-test image", () => {
  it("creates a single bounded object with the shared identity and result layout", () => {
    const image = createMotorTestImage(defaults);
    expect(inspectRbf(image)).toMatchObject({
      objectCount: 1,
      globalBytes: MOTOR_HELPER.globalBytes,
    });
    const object = decode(image).objects[0]!;
    expect(object.local).toBe(20);
    for (const forbidden of ["OUTPUT_READY", "OUTPUT_RESET", "OUTPUT_CLR_COUNT", "OUTPUT_POLARITY"])
      expect(object.ins.map((instruction) => instruction.name)).not.toContain(forbidden);
    expect(
      object.ins.filter((instruction) => instruction.name === "OUTPUT_STEP_POWER"),
    ).toHaveLength(1);
    const simulation = simulate();
    expect(simulation.globals.readInt32LE(MOTOR_HELPER.magicOffset)).toBe(MOTOR_HELPER.magic);
    expect(simulation.globals.readInt32LE(MOTOR_HELPER.tokenOffset)).toBe(defaults.token);
    expect(simulation.globals[MOTOR_HELPER.portOffset]).toBe(defaults.port);
  });

  it.each([0, 1, 2, 3])("addresses motor %i with its mask, but reads its physical port", (port) => {
    const object = decode(
      createMotorTestImage({ ...defaults, port, power: -100, angle: 3_600, brake: false }),
    ).objects[0]!;
    const step = object.ins.find((instruction) => instruction.name === "OUTPUT_STEP_POWER")!;
    expect(step.args.map((p) => p.n)).toEqual([0, 1 << port, -100, 0, 3_600, 0, 0]);
    for (const instruction of object.ins) {
      if (instruction.name === "OUTPUT_GET_COUNT") expect(instruction.args[1]!.n).toBe(port);
      if (instruction.name === "INPUT_DEVICE.GET_TYPEMODE")
        expect(instruction.args[2]!.n).toBe(16 + port);
    }
  });

  it.each([null, 2_000, 2_010])(
    "never drives an unarmed or late-armed image (arm at %s ms)",
    (armAt) => {
      const result = simulate({ armAt });
      expect(result.controls).toEqual([]);
      expect(result.result).toBe(MOTOR_HELPER.results.notArmed);
      expect(result.finishedAt).toBe(2_000);
      expect(result.endedAt).toBe(4_000);
    },
  );

  it("ignores a different invocation's acknowledgement", () => {
    const result = simulate({ armToken: defaults.token + 1 });
    expect(result.controls).toEqual([]);
    expect(result.result).toBe(MOTOR_HELPER.results.notArmed);
  });

  it.each([true, false])(
    "finishes and retains the actual count for 2 seconds (brake=%s)",
    (brake) => {
      const result = simulate({ options: { brake }, motorType: 8 });
      expect(result.controls.map((control) => control.name)).toEqual([
        "OUTPUT_STEP_POWER",
        "OUTPUT_STOP",
      ]);
      expect(result.controls[1]!.args).toEqual([0, 2, Number(brake)]);
      expect(result.globals.readInt32LE(MOTOR_HELPER.angleOffset)).toBe(430);
      expect(result.result).toBe(MOTOR_HELPER.results.complete);
      expect(result.state).toBe(MOTOR_HELPER.states.finished);
      expect(result.finishedAt).toBe(40);
      expect(result.endedAt - result.finishedAt!).toBe(2_000);
    },
  );

  it("brakes a permanently busy motor at the EV3's 10-second watchdog", () => {
    const result = simulate({ completeAfter: Infinity, options: { brake: false } });
    expect(result.controls).toHaveLength(2);
    expect(result.controls[1]).toMatchObject({ name: "OUTPUT_STOP", args: [0, 2, 1] });
    expect(result.controls[1]!.at - result.startedAt!).toBe(10_000);
    expect(result.result).toBe(MOTOR_HELPER.results.timeout);
    expect(result.endedAt - result.finishedAt!).toBe(2_000);
  });

  it("cancels and brakes when the host revokes the matching arm token", () => {
    const result = simulate({ cancelAt: 20, completeAfter: Infinity });
    expect(result.controls).toHaveLength(2);
    expect(result.controls[1]).toMatchObject({ name: "OUTPUT_STOP", at: 20, args: [0, 2, 1] });
    expect(result.result).toBe(MOTOR_HELPER.results.cancelled);
  });

  it("does not start an unsupported or missing motor", () => {
    const result = simulate({ motorType: 126 });
    expect(result.controls.map((control) => control.name)).toEqual(["OUTPUT_STOP"]);
    expect(result.result).toBe(MOTOR_HELPER.results.cancelled);
  });

  it("reports cancellation when a motor disappears instead of interpreting idle as success", () => {
    const result = simulate({ unplugAt: 20, completeAfter: 10 });
    expect(result.result).toBe(MOTOR_HELPER.results.cancelled);
    expect(result.controls[1]).toMatchObject({ name: "OUTPUT_STOP", at: 20 });
  });

  it.each([
    ["token", 0],
    ["token", -1],
    ["token", 0x80000000],
    ["token", Infinity],
    ["port", -1],
    ["port", 4],
    ["port", 1.5],
    ["power", 0],
    ["power", -101],
    ["power", 101],
    ["power", NaN],
    ["angle", 0],
    ["angle", 3_601],
    ["angle", 90.5],
    ["angle", Infinity],
  ])("rejects invalid %s: %s", (name, value) => {
    expect(() => createMotorTestImage({ ...defaults, [name as string]: value })).toThrow(
      RangeError,
    );
  });

  it("requires an actual boolean stop mode", () => {
    expect(() => createMotorTestImage({ ...defaults, brake: 1 as unknown as boolean })).toThrow(
      TypeError,
    );
  });
});
