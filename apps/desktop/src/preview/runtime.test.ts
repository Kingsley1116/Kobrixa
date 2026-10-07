import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import type { KobrixaIR } from "@kobrixa/ir";
import { describe, expect, it } from "vitest";
import { PREVIEW_LIMITS, PreviewRuntime } from "./runtime.js";
import { VirtualDevice } from "./virtual-device.js";

async function compile(content: string): Promise<KobrixaIR> {
  const result = await new BasicPlusFrontend().compile(
    {
      root: "/preview",
      manifest: {
        schemaVersion: 1,
        name: "preview",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "build",
      },
      sources: [{ path: "main.bp", content }],
      assets: [],
    },
    new AbortController().signal,
  );
  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(result.ir).toBeDefined();
  return result.ir!;
}

async function runtime(source: string, device?: VirtualDevice): Promise<PreviewRuntime> {
  return new PreviewRuntime(await compile(source), device);
}

describe("offline preview IR runtime", () => {
  it("executes against an external clock without advancing motors or copying snapshots per tick", async () => {
    class ObservedDevice extends VirtualDevice {
      snapshots = 0;
      advances = 0;
      override snapshot() {
        this.snapshots++;
        return super.snapshot();
      }
      override advance(delta: number) {
        this.advances++;
        super.advance(delta);
      }
    }
    const device = new ObservedDevice();
    const preview = new PreviewRuntime(
      await compile(`
Motor.Start("A", 100)
Program.Delay(10)
angle = Motor.GetCount("A")
Program.Delay(10)
`),
      device,
      { clock: "external", sessionInstructionLimit: null },
    );
    preview.resume();
    const snapshots = device.snapshots;
    expect(preview.executeAt(0).status).toBe("running");
    expect(device.advances).toBe(0);
    device.advance(10); // Only the world advances physical actuators.
    expect(preview.executeAt(10).status).toBe("running");
    expect(device.advances).toBe(1);
    expect(device.snapshots).toBe(snapshots);
    expect(device.consumeShaftDeltas().A).toBeCloseTo(7.2);
    expect(preview.getSnapshot().globals.angle).toBe(7);
    expect(preview.executeAt(5).error?.message).toContain("monotonic");
  });

  it("keeps execution bounded per external tick with an optional unlimited session", async () => {
    const ir = await compile("While True\n  count = count + 1\nEndWhile\n");
    const bounded = new PreviewRuntime(ir, undefined, {
      clock: "external",
      sessionInstructionLimit: 12,
    });
    bounded.resume();
    expect(bounded.executeAt(0, 100).status).toBe("error");
    const unlimited = new PreviewRuntime(ir, undefined, {
      clock: "external",
      sessionInstructionLimit: null,
    });
    unlimited.resume();
    expect(unlimited.executeAt(0, 100)).toMatchObject({ status: "running", instructions: 100 });
    expect(unlimited.executeAt(0, 100)).toMatchObject({ status: "running", instructions: 200 });
    const invalid = new PreviewRuntime(ir, undefined, { sessionInstructionLimit: Infinity });
    expect(invalid.status).toBe("error");
  });

  it("uses repeatable scene seeds for separate robot random streams", async () => {
    const ir = await compile("value = Math.GetRandomNumber(1000000)\n");
    const run = (seed: number) => {
      const preview = new PreviewRuntime(ir, undefined, { randomSeed: seed });
      preview.resume();
      return preview.runSlice(20, 0).globals.value;
    };
    expect(run(123)).toBe(run(123));
    expect(run(123)).not.toBe(run(456));
  });
  it("executes compiled control flow, numeric storage, function returns and Out parameters", async () => {
    const preview = await runtime(`
total = 0
For i = 1 To 5
  If i = 3 Then
    Continue
  EndIf
  total = total + i
EndFor
result = Clamp(total)
label = ""
Describe(result, label)
Function Clamp(in number value)
  If value > 10 Then
    Return 10
  EndIf
  Return value
EndFunction
Function Describe(in number value, out string message)
  message = "Result: " + value
EndFunction
`);
    preview.resume();
    const state = preview.runSlice(1000, 0);
    expect(state.status).toBe("completed");
    expect(state.globals).toMatchObject({ total: 12, result: 10, label: "Result: 10" });
  });

  it("preserves array aliases across calls and returns independent vector results", async () => {
    const preview = await runtime(`
samples = Vector.Data(3, "1 2 3")
Modify(samples)
sum = Vector.Add(3, samples, samples)
sorted = Vector.Sort(3, samples)
answer = sum[0]
first = sorted[0]
Function Modify(in number[] values)
  values[0] = 7
EndFunction
`);
    preview.resume();
    const state = preview.runSlice(1000, 0);
    expect(state.status).toBe("completed");
    expect(state.globals).toMatchObject({
      samples: [7, 2, 3],
      sum: [14, 4, 6],
      sorted: [2, 3, 7],
      answer: 14,
      first: 2,
    });
  });

  it("compares legacy textual flags with Boolean literals and variables in either order", async () => {
    const preview = await runtime(`
is_stuck = "False"
falsePositive = 0
If is_stuck = True Then
  falsePositive = 1
EndIf
moving = is_stuck <> True
is_stuck = "True"
stopped = 0
If is_stuck = True Then
  stopped = 1
EndIf
reverse = True = is_stuck
flag = False
falseText = "False"
falseMatches = flag = falseText
falseDiffers = is_stuck <> flag
flag = True
lowerCase = "true"
caseSensitive = lowerCase = flag
ordinaryText = "pending"
ordinaryDiffers = flag <> ordinaryText
textSame = "True" = "True"
textCaseDiffers = "True" <> "true"
`);
    preview.resume();
    const state = preview.runSlice(1000, 0);
    expect(state.status).toBe("completed");
    expect(state.globals).toMatchObject({
      falsepositive: 0,
      moving: true,
      stopped: 1,
      reverse: true,
      falsematches: true,
      falsediffers: true,
      casesensitive: false,
      ordinarydiffers: true,
      textsame: true,
      textcasediffers: true,
    });
  });

  it("supports Row handles, typed string arrays, resizing and matrix multiplication", async () => {
    const preview = await runtime(`
row = Row.Init(2, 4)
Row.Resize(row, 3)
Row.Write(row, 2, 8)
size = Row.Size(row)
last = Row.Read(row, 2)
Row.Delete(row)
names[0] = "first"
names[3] = "last"
name = names[3]
a = Vector.Data(4, "1 2 3 4")
b = Vector.Data(4, "5 6 7 8")
product = Vector.Multiply(2, 2, 2, a, b)
`);
    preview.resume();
    const state = preview.runSlice(1000, 0);
    expect(state.status).toBe("completed");
    expect(state.globals).toMatchObject({
      size: 3,
      last: 8,
      name: "last",
      product: [19, 22, 43, 50],
    });
  });

  it("uses single precision numbers and signed 32-bit integer arithmetic", async () => {
    const preview = await runtime(`
float = 16777216.1 + 1.0
wrap = 2147483647 + 1
fraction = 1 / 4
negative = -7
remainder = Math.Remainder(negative, 3)
`);
    preview.resume();
    const state = preview.runSlice(1000, 0);
    expect(state.status).toBe("completed");
    expect(state.globals).toMatchObject({
      float: 16777216,
      wrap: -2147483648,
      fraction: 0.25,
      remainder: -1,
    });
  });

  it("models BASIC text indices, byte operations and repeatable random values", async () => {
    const source = `
position = Text.GetIndexOf("robot", "bot")
part = Text.GetSubText("robot", 2, 3)
empty = Text.StartsWith("robot", "")
hex = Byte.ToHex(Byte.H("fa"))
binary = Byte.ToBinary(5)
logic = Byte.ToLogic(-1)
bit = Byte.BIT(128, 7)
random = Math.GetRandomNumber(100)
`;
    const first = await runtime(source),
      second = await runtime(source);
    first.resume();
    second.resume();
    const state = first.runSlice(1000, 0);
    expect(state.status).toBe("completed");
    expect(state.globals).toMatchObject({
      position: 3,
      part: "obo",
      empty: false,
      hex: "FA",
      binary: "00000101",
      logic: false,
      bit: 1,
    });
    expect(state.globals.random).toBe(second.runSlice(1000, 0).globals.random);
  });

  it("allows input changes while a program waits and excludes paused wall time", async () => {
    const preview = await runtime(`
before = Sensor.ReadPercent(1)
Program.Delay(100)
after = Sensor.ReadPercent(1)
elapsed = EV3.Time()
`);
    preview.setInputs({ sensors: { 1: { percent: 15 } } });
    preview.resume();
    expect(preview.runSlice(100, 0).globals.before).toBe(15);
    preview.pause();
    expect(preview.runSlice(100, 5000).elapsedMs).toBe(0);
    preview.setInputs({ sensors: { 1: { percent: 75 } } });
    preview.resume();
    expect(preview.runSlice(100, 99).status).toBe("running");
    const state = preview.runSlice(100, 1);
    expect(state.status).toBe("completed");
    expect(state.globals).toMatchObject({ before: 15, after: 75, elapsed: 100 });
  });

  it("steps instructions and virtual waits, then stops with outputs inactive", async () => {
    const preview = await runtime('Motor.Start("A", 50)\nProgram.Delay(100)\nanswer = 42\n');
    expect(preview.getSnapshot().status).toBe("ready");
    expect(preview.step()).toMatchObject({ status: "paused", instructions: 1 });
    expect(preview.getSnapshot().device.motors.A.busy).toBe(true);
    preview.step();
    const advanced = preview.step();
    expect(advanced.elapsedMs).toBe(100);
    expect(advanced.globals.answer).toBe(42);
    const stopped = preview.stop();
    expect(stopped.status).toBe("stopped");
    expect(stopped.device.motors.A.busy).toBe(false);
    expect(preview.resume().status).toBe("stopped");
  });

  it("schedules background threads independently of main and shares globals", async () => {
    const preview = await runtime(`
count = 0
Thread.Run = Worker
Program.Delay(30)
Sub Worker
  count = count + 1
  Program.Delay(10)
  count = count + 1
EndSub
`);
    preview.resume();
    expect(preview.runSlice(100, 0)).toMatchObject({ status: "running", threadCount: 2 });
    expect(preview.runSlice(100, 10).globals.count).toBe(2);
    expect(preview.runSlice(100, 20).status).toBe("completed");
  });

  it("makes button waits resumable and output parameters visible", async () => {
    const preview = await runtime(`
red = 0
green = 0
blue = 0
Sensor1.Raw3(red, green, blue)
Buttons.Wait()
pressed = Button.IsPressed("ENTER")
`);
    preview.setInputs({ sensors: { 1: { raw: [10, 20, 30] } } });
    preview.resume();
    const waiting = preview.runSlice(100, 0);
    expect(waiting.status).toBe("running");
    expect(waiting.globals).toMatchObject({ red: 10, green: 20, blue: 30 });
    preview.setInputs({ buttons: ["enter"] });
    const state = preview.runSlice(100, 16);
    expect(state.status).toBe("completed");
    expect(state.globals.pressed).toBe(true);
  });

  it("serializes calls to the same EV3 function across threads", async () => {
    const preview = await runtime(`
count = 0
Thread.Run = First
Thread.Run = Second
Program.Delay(40)
Sub First
  Increment()
EndSub
Sub Second
  Increment()
EndSub
Function Increment()
  saved = count
  Program.Delay(10)
  count = saved + 1
EndFunction
`);
    preview.resume();
    preview.runSlice(100, 0);
    preview.runSlice(100, 10);
    preview.runSlice(100, 10);
    const state = preview.runSlice(100, 20);
    expect(state.status).toBe("completed");
    expect(state.globals.count).toBe(2);
  });

  it("releases mutex waiters without spinning or blocking virtual time", async () => {
    const preview = await runtime(`
count = 0
mutex = Thread.CreateMutex()
Thread.Run = First
Thread.Run = Second
Program.Delay(40)
Sub First
  Thread.Lock(mutex)
  first = count
  Program.Delay(10)
  count = first + 1
  Thread.Unlock(mutex)
EndSub
Sub Second
  Thread.Lock(mutex)
  second = count
  Program.Delay(10)
  count = second + 1
  Thread.Unlock(mutex)
EndSub
`);
    preview.resume();
    expect(preview.runSlice(100, 0).instructions).toBeLessThan(100);
    preview.runSlice(100, 10);
    preview.runSlice(100, 10);
    const state = preview.runSlice(100, 20);
    expect(state.status).toBe("completed");
    expect(state.globals.count).toBe(2);
  });

  it("bounds an infinite loop per slice and remains stoppable", async () => {
    const preview = await runtime("While True\nThread.Yield()\nEndWhile\n");
    preview.resume();
    const state = preview.runSlice(1_000_000, 0);
    expect(state.status).toBe("running");
    expect(state.instructions).toBe(PREVIEW_LIMITS.instructionsPerSlice);
    expect(preview.stop().status).toBe("stopped");
  });

  it("bounds inspection snapshots without shortening the running program's arrays", async () => {
    const preview = await runtime(
      "samples = Vector.Init(1000, 7)\nProgram.Delay(10)\nlast = samples[999]\n",
    );
    preview.resume();
    const waiting = preview.runSlice(100, 0);
    expect(waiting.globals.samples).toHaveLength(PREVIEW_LIMITS.snapshotArrayElements);
    expect(waiting.truncatedVariables).toContain("global.samples");
    (waiting.globals.samples as number[])[0] = 999;
    const completed = preview.runSlice(100, 10);
    expect(completed.status).toBe("completed");
    expect(completed.globals.last).toBe(7);
    expect((completed.globals.samples as number[])[0]).toBe(7);
  });

  it("stops cumulative live-array exhaustion before it can overwhelm the worker", async () => {
    const preview = await runtime(
      Array.from({ length: 17 }, (_, index) => `array${index} = Vector.Init(65536, 0)`).join("\n"),
    );
    preview.resume();
    const state = preview.runSlice(1000, 0);
    expect(state.status).toBe("error");
    expect(state.error?.message).toContain("live array memory limit");
    expect(Object.values(state.globals).flat().length).toBeLessThanOrEqual(
      PREVIEW_LIMITS.snapshotValues,
    );
  });

  it("yields expensive matrix loops before the IR instruction budget is consumed", async () => {
    const preview = await runtime(`
a = Vector.Init(10000, 1)
b = Vector.Init(10000, 1)
While True
  product = Vector.Multiply(100, 100, 100, a, b)
EndWhile
`);
    preview.resume();
    const state = preview.runSlice(2000, 0);
    expect(state.status).toBe("running");
    expect(state.instructions).toBeLessThan(20);
    expect(preview.stop().status).toBe("stopped");
  });

  it.each([
    ['value = EV3.SystemCall("echo unsafe")\n', "SystemCall"],
    ["samples = Vector.Init(2, 0)\nvalue = samples[3]\n", "Array index"],
    ['Assert.Equal(1, 2, "check failed")\n', "check failed"],
    ["samples = Vector.Init(99999999, 0)\n", "Array size"],
  ])("reports source-located runtime failures for %s", async (source, message) => {
    const preview = await runtime(source);
    preview.resume();
    const state = preview.runSlice(100, 0);
    expect(state.status).toBe("error");
    expect(state.error?.message).toContain(message);
    expect(state.error?.span?.file).toBe("main.bp");
    expect(state.error?.span?.start.line).toBeGreaterThan(0);
    expect(state.device.motors.A.busy).toBe(false);
  });

  it("runs isolated file operations without touching host files", async () => {
    const device = new VirtualDevice({
      files: { "input.txt": [...new TextEncoder().encode("12\n")] },
    });
    const preview = await runtime(
      `
input = EV3File.OpenRead("input.txt")
line = EV3File.ReadLine(input)
value = EV3File.ConvertToNumber(line)
EV3File.Close(input)
output = EV3File.OpenWrite("output.txt")
EV3File.WriteLine(output, "done")
EV3File.Close(output)
`,
      device,
    );
    preview.resume();
    const state = preview.runSlice(100, 0);
    expect(state.status).toBe("completed");
    expect(state.globals.value).toBe(12);
    expect(state.device.files.some((file) => file.path.endsWith("output.txt"))).toBe(true);
  });
});
