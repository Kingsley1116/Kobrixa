import assert from "node:assert/strict";
import { test } from "node:test";
import { runCompilerRegression } from "./support/compiler-regressions.mjs";
import { decode, VM } from "./support/ev3-vm.mjs";

async function run(source, texts, optimize, scenario = {}) {
  let vm;
  await runCompilerRegression(
    { name: "API regression", source, texts },
    (bytes) => {
      vm = new VM(decode(bytes), scenario);
      return vm.run();
    },
    { optimize },
  );
  return vm;
}

for (const optimize of [false, true]) {
  test(`LCD.Text displays numeric literals and variables as floating point (${optimize})`, async () => {
    const vm = await run(
      `value = -42
LCD.Text(1, 0, 0, 1, 42)
LCD.Text(1, 0, 20, 1, value)
LCD.Text(1, 0, 40, 1, 1.25)
`,
      [],
      optimize,
    );
    assert.deepEqual(
      vm.trace.filter((entry) => entry.op === "UI_DRAW.VALUE").map((entry) => entry.args[3]),
      [42, -42, 1.25],
    );
  });

  test(`raw sensor reads accept number indexes and preserve a reused index variable (${optimize})`, async () => {
    await run(
      `Read(2, 1)
index = 2
index = Sensor.ReadRawValue(2, index)
LCD.Text(1, 0, 20, 1, "" + index)
Function Read(in number port, in number index)
  value = Sensor.ReadRawValue(port, index)
  LCD.Text(1, 0, 0, 1, "" + value)
EndFunction
`,
      ["22", "33"],
      optimize,
      { rawValues: [11, 22, 33] },
    );
  });

  test(`battery reads replace all bytes of a reused integer (${optimize})`, async () => {
    await run(
      `value = 65535
value = EV3.BatteryLevel()
LCD.Text(1, 0, 0, 1, "" + value)
`,
      ["75"],
      optimize,
    );
  });

  test(`text and byte conversions write complete strings to global variables (${optimize})`, async () => {
    await run(
      `character = "old suffix"
binary = "old suffix"
lower = "old suffix"
upper = "old suffix"
Update()
LCD.Text(1, 0, 0, 1, character + "," + binary + "," + lower + "," + upper)
Sub Update
  character = Text.GetCharacter(65)
  binary = Byte.ToBinary(165)
  lower = Text.ConvertToLowerCase("AbC")
  upper = Text.ConvertToUpperCase("aBc")
EndSub
`,
      ["A,10100101,abc,ABC"],
      optimize,
    );
  });

  test(`Math.Min and Math.Max preserve small results and avoid intermediate overflow (${optimize})`, async () => {
    await run(
      `LCD.Text(1, 0, 0, 1, "" + Math.Min(16777216, 1))
LCD.Text(1, 0, 20, 1, "" + Math.Max(-16777216, -1))
large = 300000000000000000000000000000000000000.0
minimum = Math.Min(large, large)
maximum = Math.Max(large, large)
LCD.Text(1, 0, 40, 1, "" + (minimum = large) + "," + (maximum = large))
`,
      ["1", "-1", "True,True"],
      optimize,
    );
  });

  test(`file numeric conversion handles every accepted numeric input (${optimize})`, async () => {
    await run(
      `LCD.Text(1, 0, 0, 1, "" + EV3File.ConvertToNumber(42))
value = -12.5
LCD.Text(1, 0, 20, 1, "" + EV3File.ConvertToNumber(value))
LCD.Text(1, 0, 40, 1, "" + EV3File.ConvertToNumber("3.25"))
`,
      ["42", "-12.5", "3.25"],
      optimize,
    );
  });

  test(`assertions compare Boolean values independently of adjacent storage (${optimize})`, async () => {
    await run(
      `first = True
second = True
third = False
Assert.Equal(first, second, "equal failed")
Assert.NotEqual(first, third, "not equal failed")
Assert.NotEqual(first, 1, "Boolean coercion")
Assert.NotEqual("1", 1, "text coercion")
Assert.Equal(1, 1.0, "numeric equality")
LCD.Text(1, 0, 0, 1, "passed")
`,
      ["passed"],
      optimize,
    );
  });

  test(`failed assertions format accepted numeric and Boolean messages (${optimize})`, async () => {
    await run("Assert.Equal(True, False, 42)\nLCD.Clear()\n", ["42"], optimize);
    await run("Assert.Failed(False)\nLCD.Clear()\n", ["False"], optimize);
  });

  test(`Math.Min and Math.Max retain infinities and propagate missing values (${optimize})`, async () => {
    await run(
      `missing = 0 / 0
infinite = 1 / 0
negative = 0 - infinite
For i = 1 To 2
  If i = 1 Then
    low = Math.Min(missing, 1)
    high = Math.Max(1, missing)
  Else
    low = Math.Min(1, missing)
    high = Math.Max(missing, 1)
  EndIf
  LCD.Text(1, 0, 0, 1, "" + (low <> low) + "," + (high <> high))
EndFor
low = Math.Min(negative, negative)
high = Math.Max(infinite, infinite)
LCD.Text(1, 0, 20, 1, "" + (low = negative) + "," + (high = infinite))
`,
      ["True,True", "True,True", "True,True"],
      optimize,
    );
  });

  test(`file number-array buffers are reclaimed during repeated reads and writes (${optimize})`, async () => {
    const vm = await run(
      `For i = 1 To 100
  RoundTrip(value)
EndFor
LCD.Text(1, 0, 0, 1, "" + value)
Function RoundTrip(out number value)
  data[0] = 1.25
  handle = EV3File.OpenWrite("sample.bin")
  EV3File.WriteNumberArray(handle, 1, data)
  EV3File.Close(handle)
  handle = EV3File.OpenRead("sample.bin")
  loaded = EV3File.ReadNumberArray(handle, 1)
  EV3File.Close(handle)
  value = loaded[0]
EndFunction
`,
      ["1.25"],
      optimize,
      { maxArrayHandles: 32, maxSteps: 1000000 },
    );
    assert.equal(vm.arrays.size, 0);
    assert(vm.peakArrays < 10);
  });

  test(`file arrays passed through output parameters survive helper cleanup (${optimize})`, async () => {
    await run(
      `Write()
Read(values)
LCD.Text(1, 0, 0, 1, "" + values[0] + "," + values[1000])
Function Write()
  data = Row.Init(1001, 2.5)
  handle = EV3File.OpenWrite("sample.bin")
  EV3File.WriteNumberArray(handle, 1001, data)
  EV3File.Close(handle)
  Row.Delete(data)
EndFunction
Function Read(out number[] result)
  handle = EV3File.OpenRead("sample.bin")
  result = EV3File.ReadNumberArray(handle, 1001)
  EV3File.Close(handle)
EndFunction
`,
      ["2.5,2.5"],
      optimize,
      { maxSteps: 100000 },
    );
  });

  test(`buttons, speaker commands, timers and mailbox payloads preserve their contracts (${optimize})`, async () => {
    const vm = await run(
      `Time.Reset1()
Time.Reset2()
Program.Delay(25)
Time.Reset1()
Program.Delay(10)
LCD.Text(1, 0, 0, 1, Time.Get1() + "," + Time.Get2())
LCD.Text(1, 0, 0, 1, Buttons.Current() + "," + Button.IsPressed("ENTER"))
Speaker.Tone(30, 440, 20)
LCD.Text(1, 0, 0, 1, "" + Speaker.IsBusy())
Speaker.Note(25, "A4", 100)
Speaker.Wait()
Speaker.Stop()
box = Mailbox.CreateForNumber("counter")
LCD.Text(1, 0, 0, 1, "" + Mailbox.IsAvailable(box))
value = Mailbox.ReceiveNumber(box)
LCD.Text(1, 0, 0, 1, value + "," + Mailbox.IsAvailable(box))
Mailbox.SendNumber("peer", "counter", 42)
`,
      ["10,35", "E,True", "True", "True", "12.5,False"],
      optimize,
      { mailboxes: { counter: 12.5 } },
    );
    assert.deepEqual(
      vm.trace.filter((entry) => entry.op === "SOUND.TONE").map((entry) => entry.args),
      [
        [30, 440, 20],
        [25, 440, 100],
      ],
    );
    assert.deepEqual(vm.trace.find((entry) => entry.op === "MAILBOX_WRITE").args, [
      "peer",
      0,
      "counter",
      3,
      1,
      42,
    ]);
  });
}
