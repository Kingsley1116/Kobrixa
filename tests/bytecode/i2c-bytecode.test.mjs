import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runCompilerRegression } from "./support/compiler-regressions.mjs";
import { decode, VM } from "./support/ev3-vm.mjs";

async function check(source, texts, replies) {
  let result;
  await runCompilerRegression({ name: "I2C wire order", source, texts }, (bytes) => {
    result = new VM(decode(bytes), { i2cReplies: replies }).run();
    return result;
  });
  return result.trace.filter((entry) => entry.op === "INPUT_DEVICE.SETUP");
}

test("Pixy2 signature and largest-block registers retain unsigned wire-order fields", async () => {
  const trace = await check(
    `Read(1, 2)
Function Read(in number port, in number signature)
  block = Sensor.ReadI2CRegisters(port, 1, 80 + signature, 5)
  LCD.Text(1, 0, 0, 1, block[0] + "," + block[1] + "," + block[2] + "," + block[3] + "," + block[4])
  largest = Sensor.ReadI2CRegisters(port, 1, 80, 6)
  LCD.Text(1, 0, 20, 1, largest[0] + "," + largest[1] + "," + largest[2] + "," + largest[3] + "," + largest[4] + "," + largest[5])
EndFunction
`,
    ["1,200,180,20,30", "2,0,201,181,21,31"],
    [
      [1, 200, 180, 20, 30],
      [2, 0, 201, 181, 21, 31],
    ],
  );
  assert.deepEqual(
    trace.map(({ layer, port, request }) => [layer, port, request]),
    [
      [0, 0, [1, 82]],
      [0, 0, [1, 80]],
    ],
  );
  assert.deepEqual(trace[0].reply, [30, 20, 180, 200, 1]);
});

test("CommunicateI2C preserves RGB reply order and outgoing payload order", async () => {
  const trace = await check(
    `command[0] = 94
command[1] = 200
command[2] = 180
command[3] = 1
rgb = Sensor.CommunicateI2C(1, 1, 4, 3, command)
LCD.Text(1, 0, 0, 1, rgb[0] + "," + rgb[1] + "," + rgb[2])
`,
    ["255,128,7"],
    [[255, 128, 7]],
  );
  assert.deepEqual(trace[0].request, [1, 94, 200, 180, 1]);
});

test("single-byte reads and a full 32-byte reply preserve byte boundaries", async () => {
  const bytes = Array.from({ length: 32 }, (_, index) => 224 + index);
  await check(
    `single = Sensor.ReadI2CRegister(1, 1, 8)
LCD.Text(1, 0, 0, 1, "Single: " + single)
values = Sensor.ReadI2CRegisters(1, 1, 16, 32)
For i = 0 To 31
  LCD.Text(1, 0, 20, 1, "Byte: " + values[i])
EndFor
`,
    ["Single: 255", ...bytes.map((value) => "Byte: " + value)],
    [[255], bytes],
  );
});

test("the hardware probe shows live fields, releases reply arrays, and exits on Enter", async () => {
  const source = await readFile(
    new URL("../hardware/fixtures/pixy2-signature.bp", import.meta.url),
    "utf8",
  );
  const texts = ["Pixy2 S1 sig 2", "Count: 1", "X: 200 Y: 180", "W: 20 H: 30", "Enter: exit"];
  await runCompilerRegression({ name: "Pixy2 hardware probe", source, texts }, (bytes) => {
    const scenario = { button: 0, i2cReplies: [[1, 200, 180, 20, 30]] };
    const vm = new VM(decode(bytes), scenario);
    const execute = vm.execute.bind(vm);
    vm.execute = (instruction) => {
      execute(instruction);
      if (vm.i2cReads === 1) scenario.button = 2;
    };
    const result = vm.run();
    assert.equal(vm.arrays.size, 0);
    assert(!result.trace.some((entry) => entry.op.startsWith("OUTPUT_")));
    return result;
  });
});
