import assert from "node:assert/strict";
import { test } from "node:test";
import { runCompilerRegression } from "./support/compiler-regressions.mjs";
import { decode, VM } from "./support/ev3-vm.mjs";

async function run(source, texts, scenario = {}) {
  let vm;
  await runCompilerRegression({ name: "array lifetime", source, texts }, (bytes) => {
    vm = new VM(decode(bytes), {
      maxSteps: 1000000,
      maxTrace: 20000,
      maxArrayHandles: 250,
      ...scenario,
    });
    return vm.run();
  });
  return vm;
}

test("camera polling reclaims local aliases and transfer buffers on every call", async () => {
  const vm = await run(
    `For i = 1 To 1000
  GetSignature(1, 2, x)
EndFor
LCD.Text(1, 0, 0, 1, "X: " + x)
Function GetSignature(in number port, in number sig, out number x)
  values = Sensor.ReadI2CRegisters(port, 1, 80 + sig, 5)
  alias = values
  x = alias[1]
EndFunction
`,
    ["X: 200"],
    { i2cReplies: Array.from({ length: 1000 }, () => [1, 200, 180, 20, 30]) },
  );
  assert.equal(vm.arrays.size, 0);
  assert(vm.peakArrays <= 6);
  assert.equal(vm.i2cReads, 1000);
});

test("two threads can share a polling helper without leaking or double-deleting arrays", async () => {
  const vm = await run(
    `finished = false
Thread.Run = Poll
For i = 1 To 250
  Sample(mainValue)
EndFor
While Not finished
  Thread.Yield()
EndWhile
LCD.Text(1, 0, 0, 1, mainValue + "," + workerValue)
Sub Poll
  For j = 1 To 250
    Sample(workerValue)
  EndFor
  finished = true
EndSub
Function Sample(out number value)
  data = Sensor.ReadI2CRegisters(1, 1, 82, 5)
  value = data[1]
EndFunction
`,
    ["42,42"],
    { quantum: 1 },
  );
  assert.equal(vm.arrays.size, 0);
  assert(vm.peakArrays <= 5);
  assert(vm.scheduler.contendedCalls > 0);
});

test("UART, raw reads and I2C writes release compiler-owned buffers", async () => {
  const vm = await run(
    `For i = 1 To 1000
  Sample(value)
EndFor
LCD.Text(1, 0, 0, 1, "Value: " + value)
Function Sample(out number value)
  command[0] = 17
  Sensor.SendUARTData(2, 1, command)
  raw = Sensor.ReadRaw(2, 2)
  value = raw[0]
  Sensor.WriteI2CRegister(1, 1, 80, 17)
  Sensor.WriteI2CRegisters(1, 1, 80, 1, command)
  reply = Sensor.CommunicateI2C(1, 1, 1, 1, command)
  value += reply[0]
EndFunction
`,
    ["Value: 42"],
    { sensor: 0 },
  );
  assert.equal(vm.arrays.size, 0);
  assert(vm.peakArrays < 12);
});

test("arrays returned through output parameters survive helper cleanup", async () => {
  await run(
    `Read(values)
LCD.Text(1, 0, 0, 1, "Value: " + values[1])
Function Read(out number[] result)
  result = Sensor.ReadI2CRegisters(1, 1, 82, 5)
EndFunction
`,
    ["Value: 200"],
    { i2cReplies: [[1, 200, 180, 20, 30]] },
  );
});

test("a sensor array assigned to a global remains valid after return", async () => {
  await run(
    `saved[0] = 0
Read()
LCD.Text(1, 0, 0, 1, "Value: " + saved[1])
Function Read()
  values = Sensor.ReadI2CRegisters(1, 1, 82, 5)
  @saved = values
EndFunction
`,
    ["Value: 200"],
    { i2cReplies: [[1, 200, 180, 20, 30]] },
  );
});
