import assert from "node:assert/strict";
import { BasicPlusFrontend } from "../../../frontends/basic-plus/dist/index.js";
import { EV3Backend } from "../../../packages/backend-ev3/dist/index.js";
import { validateIR } from "../../../packages/ir/dist/index.js";

const countdown = (depth) => `LCD.Text(1, 0, 0, 1, "Result: " + Count(${depth}))
Function Count(in number n)
  If n > 0 Then
    Return 1 + Count(n - 1)
  EndIf
  Return 1
EndFunction
`;
export const compilerFixtures = [
  {
    name: "computed motor power preserves direction across signed-byte boundaries",
    source: `Drive(-160, 160)
Drive(-128, 128)
Drive(-625, 625)
Drive(-100.9, 100.9)
Drive(-45.9, 45.9)
MotorBC.SetPower(256)
MotorBC.StartSpeed(-256)
Function Drive(in number left, in number right)
  MotorB.StartPower(left)
  MotorC.StartPower(right)
EndFunction
`,
    texts: [],
    motorCommands: [
      ["OUTPUT_POWER", 0, 2, -100],
      ["OUTPUT_POWER", 0, 4, 100],
      ["OUTPUT_POWER", 0, 2, -100],
      ["OUTPUT_POWER", 0, 4, 100],
      ["OUTPUT_POWER", 0, 2, -100],
      ["OUTPUT_POWER", 0, 4, 100],
      ["OUTPUT_POWER", 0, 2, -100],
      ["OUTPUT_POWER", 0, 4, 100],
      ["OUTPUT_POWER", 0, 2, -45],
      ["OUTPUT_POWER", 0, 4, 45],
      ["OUTPUT_POWER", 0, 6, 100],
      ["OUTPUT_SPEED", 0, 6, -100],
    ],
  },
  {
    name: "generic motor APIs bound power and speed without narrowing wraparound",
    source: `power = 160
Motor.Start("BC", power)
Motor.StartPower("BC", 0-power)
Motor.Move("BC", power, 90, "True")
Motor.MovePower("BC", 0-power, 90, "True")
Motor.Schedule("BC", power, 10, 20, 30, "True")
Motor.SchedulePower("BC", 0-power, 10, 20, 30, "True")
Motor.StartSteer("BC", power, 50)
Motor.ScheduleSteer("BC", 0-power, 50, 90, "True")
Motor.MoveSteer("BC", power, 50, 90, "True")
`,
    texts: [],
    motorCommands: [
      ["OUTPUT_SPEED", 0, 6, 100],
      ["OUTPUT_POWER", 0, 6, -100],
      ["OUTPUT_STEP_SPEED", 0, 6, 100, 0, 90, 0, 1],
      ["OUTPUT_STEP_POWER", 0, 6, -100, 0, 90, 0, 1],
      ["OUTPUT_STEP_SPEED", 0, 6, 100, 10, 20, 30, 1],
      ["OUTPUT_STEP_POWER", 0, 6, -100, 10, 20, 30, 1],
      ["OUTPUT_STEP_SYNC", 0, 6, 100, 50, 0, 0],
      ["OUTPUT_STEP_SYNC", 0, 6, -100, 50, 90, 1],
      ["OUTPUT_STEP_SYNC", 0, 6, 100, 50, 90, 1],
    ],
  },
  {
    name: "numeric outputs widen variables initialized with integer literals",
    source: `value = 0
ReadValue(value)
LCD.Text(1, 0, 0, 1, "Value: " + value)
Function ReadValue(out number result)
  result = 1.5
EndFunction
`,
    texts: ["Value: 1.5"],
  },
  {
    name: "late global widening propagates through earlier arithmetic and copies",
    source: `x = 700
difference = 650 - x
copy = difference
LCD.Text(1, 0, 0, 1, "Difference: " + copy)
Update()
difference = 650 - x
LCD.Text(1, 0, 20, 1, "Updated: " + difference)
Sub Update
  x = 700.5
EndSub
`,
    texts: ["Difference: -50", "Updated: -50.5"],
  },
  {
    name: "program timers share reset baselines across functions and threads",
    source: `Time.Reset5()
Program.Delay(25)
ReadTimer()
Thread.Run = Worker
Program.Delay(50)
Sub ReadTimer
  LCD.Text(1, 0, 0, 1, "Timer: " + Time.Get5())
EndSub
Sub Worker
  ReadTimer()
EndSub
`,
    texts: ["Timer: 25", "Timer: 25"],
  },
  {
    name: "row handles survive number parameters and numeric assignments",
    source: `Create(data)
LCD.Text(1, 0, 0, 1, "Value: " + Row.Read(data, 0))
Row.Resize(data, 6)
LCD.Text(1, 0, 20, 1, "Size: " + Row.Size(data))
Row.Delete(data)
Function Create(out number handle)
  handle = Row.Init(4, 7)
  Row.Write(handle, 0, 9)
EndFunction
`,
    texts: ["Value: 9", "Size: 6"],
  },
  {
    name: "input array parameters retain the caller's contents and handle",
    source: `values[0] = 17
Consume(values)
LCD.Text(1, 0, 20, 1, "Caller: " + values[0])
Function Consume(in number[] items)
  LCD.Text(1, 0, 0, 1, "Input: " + items[0])
  items[0] = 23
EndFunction
`,
    texts: ["Input: 17", "Caller: 23"],
  },
  {
    name: "byte high-bit literals and masks match stock EV3 semantics",
    source: `LCD.Text(1, 0, 0, 1, Byte.OR_(128, 0) + "," + Byte.SHR(128, 1))
LCD.Text(1, 0, 20, 1, Byte.BIT(165, 7) + "," + Byte.BIT(165, 1) + "," + Byte.BIT(1, 0))
LCD.Text(1, 0, 40, 1, Byte.ToHex(255) + "," + Byte.ToBinary(128))
`,
    texts: ["128,64", "1,0,1", "FF,10000000"],
  },
  {
    name: "32 recursive frames retain separate locals and return values",
    source: countdown(31),
    texts: ["Result: 32"],
  },
  {
    name: "recursion overflow stops with an explicit message",
    source: countdown(32),
    texts: ["Recursion exceeds 32 frames"],
  },
  {
    name: "mutual recursion uses separate native objects",
    source: `LCD.Text(1, 0, 0, 1, "Result: " + First(4))
Function First(in number n)
  If n > 0 Then
    Return 1 + Second(n - 1)
  EndIf
  Return 1
EndFunction
Function Second(in number n)
  If n > 0 Then
    Return 1 + First(n - 1)
  EndIf
  Return 1
EndFunction
`,
    texts: ["Result: 5"],
  },
];
export async function runCompilerRegression(fixture, execute) {
  const front = await new BasicPlusFrontend().compile(
    {
      root: "/audit",
      manifest: {
        schemaVersion: 1,
        name: "regression",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "build",
      },
      sources: [{ path: "main.bp", content: fixture.source }],
      assets: [],
    },
    new AbortController().signal,
  );
  assert.deepEqual(front.diagnostics, [], fixture.name);
  assert.deepEqual(validateIR(front.ir), [], fixture.name);
  const back = await new EV3Backend().compile(front.ir, new AbortController().signal);
  assert.deepEqual(back.diagnostics, [], fixture.name);
  const run = execute(back.rbf);
  assert.equal(run.status, "ended", fixture.name + ": " + run.error);
  assert.deepEqual(
    run.trace.filter((entry) => entry.op === "UI_DRAW.TEXT").map((entry) => entry.args[3]),
    fixture.texts,
    fixture.name,
  );
  if (fixture.motorCommands)
    assert.deepEqual(
      run.trace
        .filter((entry) => /^OUTPUT_(POWER|SPEED|STEP_)/.test(entry.op))
        .map((entry) => [entry.op, ...entry.args]),
      fixture.motorCommands,
      fixture.name,
    );
  return { name: fixture.name, bytes: back.rbf.length, steps: run.steps, pass: true };
}
export async function runCompilerRegressions(execute) {
  const results = [];
  for (const fixture of compilerFixtures)
    results.push(await runCompilerRegression(fixture, execute));
  return results;
}
