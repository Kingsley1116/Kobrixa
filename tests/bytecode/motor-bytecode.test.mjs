import assert from "node:assert/strict";
import { test } from "node:test";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";
import { EV3Backend } from "../../packages/backend-ev3/dist/index.js";
import { validateIR } from "../../packages/ir/dist/index.js";
import { decode, VM } from "./support/ev3-vm.mjs";

async function run(source, optimize, scenario = {}) {
  const front = await new BasicPlusFrontend().compile(
    {
      root: "/motor-test",
      manifest: {
        schemaVersion: 1,
        name: "motor-test",
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
  assert.deepEqual(front.diagnostics, []);
  assert.deepEqual(validateIR(front.ir), []);
  const back = await new EV3Backend({ optimize }).compile(front.ir, new AbortController().signal);
  assert.deepEqual(back.diagnostics, []);
  const result = new VM(decode(back.rbf), scenario).run();
  assert.equal(result.status, "ended", result.error);
  return result.trace;
}

const commands = (trace) =>
  trace.filter((entry) => entry.op.startsWith("OUTPUT_")).map((entry) => [entry.op, ...entry.args]);

for (const optimize of [false, true]) {
  test(`motor port strings keep their mask and layer as literals, variables and parameters (${optimize})`, async () => {
    for (const [ports, layer, mask] of [
      ["BC", 0, 6],
      ["db", 0, 10],
      ["ABCD", 0, 15],
      ["A2", 1, 1],
      ["bc4", 3, 6],
    ]) {
      const trace = await run(
        `ports = "${ports}"
Motor.Start("${ports}", 25)
Motor.Start(ports, 25)
Drive(ports)
Function Drive(in string selected)
  Motor.Start(selected, 25)
  Motor.Stop(selected, True)
  Motor.ResetCount(selected)
  Motor.Invert(selected)
  Motor.Wait(selected)
EndFunction
`,
        optimize,
      );
      assert.deepEqual(
        commands(trace),
        [
          ...Array.from({ length: 3 }, () => [
            ["OUTPUT_SPEED", layer, mask, 25],
            ["OUTPUT_START", layer, mask],
          ]).flat(),
          ["OUTPUT_STOP", layer, mask, 1],
          ["OUTPUT_CLR_COUNT", layer, mask],
          ["OUTPUT_POLARITY", layer, mask, 0],
          ["OUTPUT_READY", layer, mask],
        ],
        ports,
      );
    }
  });

  test(`all motor start variants accept computed ports (${optimize})`, async () => {
    for (const [ports, layer] of [
      ["BC", 0],
      ["BC2", 1],
    ]) {
      const trace = await run(
        `Drive("${ports}")
Function Drive(in string ports)
  Motor.StartPower(ports, -40)
  Motor.StartSteer(ports, 50, -100)
  Motor.StartSync(ports, 25, 50)
EndFunction
`,
        optimize,
      );
      assert.deepEqual(commands(trace), [
        ["OUTPUT_POWER", layer, 6, -40],
        ["OUTPUT_START", layer, 6],
        ["OUTPUT_STEP_SYNC", layer, 6, 50, -100, 0, 0],
        ["OUTPUT_STEP_SYNC", layer, 6, 50, -50, 0, 0],
      ]);
    }
  });

  test(`computed motor addresses reach every scheduled, blocking and read operation (${optimize})`, async () => {
    const trace = await run(
      `ports = "BD"
Motor.Move(ports, -25, 90, True)
Motor.MovePower(ports, 25, 90, False)
Motor.Schedule(ports, 25, 10, 20, 30, True)
Motor.SchedulePower(ports, -25, 10, 20, 30, False)
Motor.ScheduleSteer(ports, 50, 100, 90, True)
Motor.MoveSteer(ports, 50, 100, 90, True)
Motor.ScheduleSync(ports, 50, 0, 90, True)
Motor.MoveSync(ports, 50, 0, 90, True)
busy = Motor.IsBusy(ports)
port = "d"
LCD.Text(1, 0, 0, 1, "" + Motor.GetCount(port))
LCD.Text(1, 0, 20, 1, "" + Motor.GetSpeed(port))
`,
      optimize,
      { motorSpeed: -75, motorCount: -12345 },
    );
    assert.deepEqual(commands(trace), [
      ["OUTPUT_STEP_SPEED", 0, 10, -25, 0, 90, 0, 1],
      ["OUTPUT_READY", 0, 10],
      ["OUTPUT_STEP_POWER", 0, 10, 25, 0, 90, 0, 0],
      ["OUTPUT_READY", 0, 10],
      ["OUTPUT_STEP_SPEED", 0, 10, 25, 10, 20, 30, 1],
      ["OUTPUT_STEP_POWER", 0, 10, -25, 10, 20, 30, 0],
      ["OUTPUT_STEP_SYNC", 0, 10, 50, 100, 90, 1],
      ["OUTPUT_STEP_SYNC", 0, 10, 50, 100, 90, 1],
      ["OUTPUT_READY", 0, 10],
      ["OUTPUT_STEP_SYNC", 0, 10, 50, 100, 90, 1],
      ["OUTPUT_STEP_SYNC", 0, 10, 50, 100, 90, 1],
      ["OUTPUT_READY", 0, 10],
      ["OUTPUT_TEST", 0, 10, 0],
      ["OUTPUT_GET_COUNT", 0, 3, -12345],
      ["OUTPUT_READ", 0, 3, -75, -12345],
    ]);
  });

  test(`malformed computed addresses select no motor outputs (${optimize})`, async () => {
    for (const ports of ["", "2", "A0", "B5", "A2B", "BC22", "BE", "B C", "A/", "@"]) {
      const trace = await run(`ports = "${ports}"\nMotor.Start(ports, 25)\n`, optimize);
      assert.deepEqual(
        commands(trace),
        [
          ["OUTPUT_SPEED", 0, 0, 25],
          ["OUTPUT_START", 0, 0],
        ],
        ports,
      );
    }
  });

  test(`synchronized speed keeps zero stopped and bounds each wheel before computing the ratio (${optimize})`, async () => {
    for (const [first, second, speed, turn] of [
      [0, 0, 0, 0],
      [160, 80, 100, 20],
      [-160, 80, -100, 180],
      [80, -160, -100, -180],
      [0, -50, -50, -100],
      [-50, 0, -50, 100],
      [0.9, -0.9, 0, 0],
    ]) {
      const trace = await run(
        `Drive(${first}, ${second})
Function Drive(in number first, in number second)
  Motor.StartSync("BC", first, second)
  Motor.ScheduleSync("BC", first, second, 90, True)
  Motor.MoveSync("BC", first, second, 90, True)
EndFunction
`,
        optimize,
      );
      assert.deepEqual(
        commands(trace),
        [
          ["OUTPUT_STEP_SYNC", 0, 6, speed, turn, 0, 0],
          ["OUTPUT_STEP_SYNC", 0, 6, speed, turn, 90, 1],
          ["OUTPUT_STEP_SYNC", 0, 6, speed, turn, 90, 1],
          ["OUTPUT_READY", 0, 6],
        ],
        `${first}, ${second}`,
      );
    }
  });

  test(`steering ratios are bounded before narrowing to a signed word (${optimize})`, async () => {
    for (const turn of [-65536, -201, -200, 200, 201, 65536]) {
      const trace = await run(
        `Steer(${turn})
Function Steer(in number turn)
  Motor.StartSteer("BC", 50, turn)
  Motor.ScheduleSteer("BC", 50, turn, 90, True)
  Motor.MoveSteer("BC", 50, turn, 90, True)
EndFunction
`,
        optimize,
      );
      const bounded = Math.max(-200, Math.min(200, turn));
      assert.deepEqual(commands(trace), [
        ["OUTPUT_STEP_SYNC", 0, 6, 50, bounded, 0, 0],
        ["OUTPUT_STEP_SYNC", 0, 6, 50, bounded, 90, 1],
        ["OUTPUT_STEP_SYNC", 0, 6, 50, bounded, 90, 1],
        ["OUTPUT_READY", 0, 6],
      ]);
    }
  });

  test(`legacy motor reads and settings address the selected port and preserve negative speed (${optimize})`, async () => {
    for (const [index, port] of [..."ABCD"].entries()) {
      const trace = await run(
        `Motor${port}.IsLarge()
Motor${port}.IsMedium()
Motor${port}.SetReversPolarity()
Motor${port}.SetDirectPolarity()
LCD.Text(1, 0, 0, 1, "" + Motor${port}.GetSpeed())
LCD.Text(1, 0, 20, 1, "" + Motor${port}.GetTacho())
`,
        optimize,
        { motorSpeed: -75, motorCount: -12345 },
      );
      assert.deepEqual(commands(trace), [
        ["OUTPUT_SET_TYPE", 0, index, 7],
        ["OUTPUT_SET_TYPE", 0, index, 8],
        ["OUTPUT_POLARITY", 0, 1 << index, -1],
        ["OUTPUT_POLARITY", 0, 1 << index, 1],
        ["OUTPUT_READ", 0, index, -75, -12345],
        ["OUTPUT_GET_COUNT", 0, index, -12345],
      ]);
      assert.deepEqual(
        trace.filter((entry) => entry.op === "UI_DRAW.TEXT").map((entry) => entry.args[3]),
        ["-75", "-12345"],
      );
    }
  });
}
