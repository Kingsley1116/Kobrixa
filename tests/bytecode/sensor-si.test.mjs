import assert from "node:assert/strict";
import { test } from "node:test";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";
import { EV3Backend } from "../../packages/backend-ev3/dist/index.js";
import { validateIR } from "../../packages/ir/dist/index.js";
import { decode, VM } from "./support/ev3-vm.mjs";

async function compile(source) {
  return new BasicPlusFrontend().compile(
    {
      root: "/si-test",
      manifest: {
        schemaVersion: 1,
        name: "sensor-si",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "build",
      },
      sources: [{ path: "main.bp", content: source }],
      assets: [],
    },
    new AbortController().signal,
  );
}
async function run(source, scenario = {}) {
  const front = await compile(source);
  assert.deepEqual(front.diagnostics, []);
  assert.deepEqual(validateIR(front.ir), []);
  const back = await new EV3Backend().compile(front.ir, new AbortController().signal);
  assert.deepEqual(back.diagnostics, []);
  const decoded = decode(back.rbf);
  const vm = new VM(decoded, scenario);
  const result = vm.run();
  assert.equal(result.status, "ended", result.error);
  return {
    vm,
    decoded,
    texts: result.trace.filter((item) => item.op === "UI_DRAW.TEXT").map((item) => item.args[3]),
  };
}
const display = `If value <> value Then
  LCD.Text(1, 0, 0, 1, "missing")
Else
  LCD.Text(1, 0, 0, 1, "" + value)
EndIf
`;

test("SI reads preserve fractions and channel selection without changing the current mode", async () => {
  const { vm, decoded, texts } = await run(`value = Sensor.ReadSIValue(1, 1)\n${display}`, {
    siValues: [9123, -12.25],
    rawValues: [0, 999],
    sensorMode: 2,
  });
  assert.deepEqual(texts, ["-12.25"]);
  const read = vm.trace.find((item) => item.op === "INPUT_READEXT");
  assert.deepEqual(
    { port: read.port, layer: read.layer, mode: read.mode, format: read.format },
    { port: 0, layer: 0, mode: -1, format: 19 },
  );
  const operations = decoded.objects.flatMap((object) =>
    object.ins.map((instruction) => instruction.name),
  );
  assert(
    !operations.some((name) => name.includes("READY")),
    "ReadSIValue must not wait or select modes",
  );
  assert.deepEqual(vm.modes, {});
});

test("computed port and channel parameters use correct daisy-chain addresses", async () => {
  for (const port of [1, 4, 5, 16]) {
    const { vm, texts } = await run(
      `Read(${port}, 7)
Function Read(in number port, in number channel)
  value = Sensor.ReadSIValue(port, channel)
  ${display}
EndFunction
`,
      { siValues: [0, 1, 2, 3, 4, 5, 6, 7.5] },
    );
    assert.deepEqual(texts, ["7.5"]);
    assert.equal(
      vm.trace.find((item) => item.op === "INPUT_READEXT").layer,
      Math.floor((port - 1) / 4),
    );
    assert.equal(vm.trace.find((item) => item.op === "INPUT_READEXT").port, (port - 1) % 4);
  }
});

test("invalid computed parameters return NaN before any input read", async () => {
  for (const [port, channel] of [
    [0, 0],
    [-1, 0],
    [17, 0],
    [257, 0],
    [1.5, 0],
    [1, -1],
    [1, 8],
    [1, 0.5],
  ]) {
    const { texts, vm } = await run(`Read(${port}, ${channel})
Function Read(in number port, in number channel)
  value = Sensor.ReadSIValue(port, channel)
  ${display}
EndFunction
`);
    assert.deepEqual(texts, ["missing"], `${port}, ${channel}`);
    assert.equal(vm.siReads, 0);
  }
  const { texts, vm } = await run(`number port
port = 0 / 0
value = Sensor.ReadSIValue(port, 0)
${display}`);
  assert.deepEqual(texts, ["missing"]);
  assert.equal(vm.siReads, 0);
});

test("invalid literal arguments have actionable compile diagnostics", async () => {
  for (const args of ["0, 0", "17, 0", "-1, 0", "1.5, 0", "1, -1", "1, 8", "1, 0.5"]) {
    const result = await compile(`value = Sensor.ReadSIValue(${args})`);
    assert(
      result.diagnostics.some((diagnostic) => diagnostic.code === "EV32031"),
      args,
    );
  }
  assert(
    (await compile('value = Sensor.ReadSIValue("one", 0)')).diagnostics.some(
      (item) => item.code === "BP3004",
    ),
  );
  assert(
    (await compile("value = Sensor.ReadSIValue(1)")).diagnostics.some(
      (item) => item.code === "BP3002",
    ),
  );
});

test("absent channels, busy inputs, invalid metadata and nonfinite SI remain missing", async () => {
  for (const scenario of [
    { siValues: [42], sensorDatasets: 0 },
    { siValues: [42], sensorBusy: 1 },
    { siValues: [42], sensorBusyValues: [0, 1] },
    { siValues: [NaN] },
    { siValues: [Infinity] },
    { siValues: [-Infinity] },
    ...[0, 125, 126, 127, 255].map((sensorType) => ({ sensorType })),
    { sensorMode: -1 },
    { sensorMode: 8 },
    {
      sensorMetadata: [
        { type: 29, mode: 0 },
        { type: 30, mode: 0 },
      ],
      siValues: [3],
    },
    {
      sensorMetadata: [
        { type: 29, mode: 0 },
        { type: 29, mode: 1 },
      ],
      siValues: [3],
    },
  ]) {
    const { texts } = await run(`value = Sensor.ReadSIValue(1, 0)\n${display}`, scenario);
    assert.deepEqual(texts, ["missing"], JSON.stringify(scenario));
  }
  const { texts } = await run(`value = Sensor.ReadSIValue(1, 1)\n${display}`, { siValues: [42] });
  assert.deepEqual(texts, ["missing"]);
  const zero = await run(`value = Sensor.ReadSIValue(1, 0)\n${display}`, { siValues: [0] });
  assert.deepEqual(zero.texts, ["0"]);
});

test("using the result variable as the port does not overwrite its input before validation", async () => {
  const { texts } = await run(
    `number value
value = 1
value = Sensor.ReadSIValue(value, 0)
${display}`,
    { siValues: [27.5] },
  );
  assert.deepEqual(texts, ["27.5"]);
});
