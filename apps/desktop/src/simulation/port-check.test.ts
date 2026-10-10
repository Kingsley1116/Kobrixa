import { describe, expect, it } from "vitest";
import type { IRInstruction, KobrixaIR } from "@kobrixa/ir";
import type { PreparedSimulation } from "../shared/simulator.js";
import { checkRobotPorts } from "./port-check.js";
import { createDefaultScene, createPracticeScene } from "./scene.js";

const span = (line: number) => ({
  file: "src/main.bp",
  start: { line, column: 1, offset: 0 },
  end: { line, column: 2, offset: 1 },
});
function program(instructions: IRInstruction[]): PreparedSimulation["programs"][string] {
  const ir: KobrixaIR = {
    version: 1,
    program: { name: "main", entryFunction: "main" },
    globals: [],
    functions: [
      {
        name: "main",
        parameters: [],
        returnType: { kind: "void" },
        locals: [],
        entryBlock: "entry",
        blocks: [{ id: "entry", instructions, terminator: { op: "stop" } }],
      },
    ],
    resources: [],
    sourceFiles: ["src/main.bp"],
  };
  return { ir, files: {} };
}
const call = (operation: string, args: unknown[], line = 1) =>
  ({ op: "ev3-call", operation, args, span: span(line) }) as IRInstruction;

describe("program and robot port check", () => {
  it("accepts a Driving Base program that uses B, C and all four sensors", () => {
    const scene = createPracticeScene("src/main.bp");
    const prepared = {
      programs: {
        "src/main.bp": program([
          call("Motor.Start", [
            { kind: "string", value: "BC" },
            { kind: "integer", value: 50 },
          ]),
          ...[1, 2, 3, 4].map((port) =>
            call("Sensor.ReadPercent", [{ kind: "integer", value: port }]),
          ),
        ]),
      },
    };
    expect(checkRobotPorts(scene, prepared)).toEqual([]);
  });

  it("reports each missing motor and sensor port once with its first location", () => {
    const scene = createPracticeScene("src/main.bp");
    scene.robots[0]!.sensors = scene.robots[0]!.sensors.filter((sensor) => sensor.port !== 3);
    const prepared = {
      programs: {
        "src/main.bp": program([
          call("Motor.Move", [{ kind: "string", value: "ad" }], 2),
          call("Motor.Stop", [{ kind: "string", value: "A" }], 3),
          call("Sensor.ReadPercent", [{ kind: "integer", value: 3 }], 4),
          call("Sensor.SetMode", [{ kind: "number", value: 3 }], 5),
        ]),
      },
    };
    expect(checkRobotPorts(scene, prepared)).toEqual([
      { robotId: "A1", kind: "motor", port: "A", span: span(2) },
      { robotId: "A1", kind: "motor", port: "D", span: span(2) },
      { robotId: "A1", kind: "sensor", port: "3", span: span(4) },
    ]);
  });

  it("ignores variable ports, non-port calls and robots without programs", () => {
    const scene = createDefaultScene("src/main.bp");
    const prepared = {
      programs: {
        "src/main.bp": program([
          call("Motor.Start", [{ kind: "variable", name: "port" }]),
          call("LCD.Text", [{ kind: "integer", value: 1 }]),
          call("Sensor.ReadPercent", [{ kind: "integer", value: 7 }]),
          // The WRO robot's shooter owns motor D.
          call("Motor.Move", [{ kind: "string", value: "D" }]),
        ]),
      },
    };
    expect(checkRobotPorts(scene, prepared)).toEqual([]);
  });
});
