import assert from "node:assert/strict";
import { test } from "node:test";
import { runCompilerRegression } from "./support/compiler-regressions.mjs";
import { decode, VM } from "./support/ev3-vm.mjs";

for (const optimize of [false, true]) {
  test(`timed drives preserve direction, delay and braking across repeated calls (${optimize})`, async () => {
    let result;
    await runCompilerRegression(
      {
        name: "timed drives",
        source: `Drive(50, 50, 200)
Drive(-50, -40, 150)
Drive(25, 25, 75)
Drive(100, 100, 500)
Function Drive(in number left, in number right, in number duration)
  MotorB.StartPower(-left)
  MotorC.StartPower(right)
  Program.Delay(duration)
  Motor.Stop("BC", True)
EndFunction
`,
        texts: [],
      },
      (bytes) => (result = new VM(decode(bytes)).run()),
      { optimize },
    );
    assert.deepEqual(
      result.trace.filter((entry) =>
        ["OUTPUT_POWER", "OUTPUT_STOP", "TIMER_WAIT"].includes(entry.op),
      ),
      [
        [50, 50, 200],
        [-50, -40, 150],
        [25, 25, 75],
        [100, 100, 500],
      ].flatMap(([left, right, ms]) => [
        { op: "OUTPUT_POWER", args: [0, 2, -left] },
        { op: "OUTPUT_POWER", args: [0, 4, right] },
        { op: "TIMER_WAIT", ms },
        { op: "OUTPUT_STOP", args: [0, 6, 1] },
      ]),
    );
  });

  test(`sensor-driven turns stop for both heading signs (${optimize})`, async () => {
    for (const sign of [-1, 1]) {
      let result;
      await runCompilerRegression(
        {
          name: "sensor-driven turn",
          source: `Turn(${sign})
Function Turn(in number direction)
  While Math.Abs(Sensor.ReadRawValue(2, 0)) < 30
    MotorBC.StartPower(direction * 45)
  EndWhile
  Motor.Stop("BC", True)
EndFunction
`,
          texts: [],
        },
        (bytes) => {
          const vm = new VM(decode(bytes));
          const execute = vm.execute.bind(vm);
          let sample = 0;
          vm.execute = (instruction) => {
            if (instruction.name === "INPUT_DEVICE.READY_RAW")
              vm.s.rawValues = [sign * [0, 10, 20, 30][sample++]];
            execute(instruction);
          };
          result = vm.run();
          assert.equal(sample, 4);
          return result;
        },
        { optimize },
      );
      assert.deepEqual(
        result.trace.filter((entry) => entry.op === "OUTPUT_POWER").map((entry) => entry.args),
        Array.from({ length: 3 }, () => [0, 6, sign * 45]),
      );
      assert.deepEqual(result.trace.at(-1), { op: "OUTPUT_STOP", args: [0, 6, 1] });
    }
  });
}
