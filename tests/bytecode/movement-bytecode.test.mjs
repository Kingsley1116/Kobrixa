import assert from "node:assert/strict";
import { test } from "node:test";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";
import { EV3Backend } from "../../packages/backend-ev3/dist/index.js";
import { decode, VM } from "./support/ev3-vm.mjs";

// A minimal compiler input, independent of any application project or assets.
const source = `Steer(1, 20, 0, 0)
Function Steer(in number gain, in number drive, in number target, in number heading)
  correction = (heading + target) * gain
  MotorB.StartPower(-(drive + correction))
  MotorC.StartPower(drive - correction)
EndFunction
`;
const clamp = (value) => Math.trunc(Math.max(-100, Math.min(100, value))) || 0;

for (const optimize of [false, true]) {
  test(`steering arithmetic across 5,460 inputs and reused object memory (${optimize})`, async () => {
    const frontend = await new BasicPlusFrontend().compile(
      {
        root: "/steering-test",
        manifest: {
          schemaVersion: 1,
          name: "steering-test",
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
    assert.deepEqual(frontend.diagnostics, []);
    const backend = await new EV3Backend({ optimize }).compile(
      frontend.ir,
      new AbortController().signal,
    );
    assert.deepEqual(backend.diagnostics, []);
    const decoded = decode(backend.rbf);
    const names = backend.listing
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[1]);
    const index = names.indexOf("steer");
    assert(index >= 0, "steering subcall is present");
    const vm = new VM(decoded);
    vm.frames.pop();
    vm.activeObjects.clear();
    let cases = 0;
    for (const gain of [1, 1.5, 2, 3, 5, 6])
      for (const drive of [-100, -60, -50, -30, 25, 40, 45, 50, 60, 100])
        for (const target of [-105, -5, 0, 5, 10, 27, 45])
          for (const heading of [-180, -150, -90, -45, -20, -10, 0, 10, 20, 45, 90, 150, 180]) {
            const frame = vm.start(index);
            [gain, drive, target, heading].forEach((value, i) =>
              frame.l.writeFloatLE(value, i * 4),
            );
            vm.trace = [];
            vm.steps = 0;
            const result = vm.run();
            assert.equal(result.status, "ended", result.error);
            assert.deepEqual(
              result.trace
                .filter((entry) => entry.op === "OUTPUT_POWER")
                .map((entry) => entry.args),
              [
                [0, 2, clamp(-(drive + (heading + target) * gain))],
                [0, 4, clamp(drive - (heading + target) * gain)],
              ],
              JSON.stringify({ gain, drive, target, heading }),
            );
            cases++;
          }
    assert.equal(cases, 5460);
  });
}
