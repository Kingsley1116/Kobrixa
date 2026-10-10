import { getEV3Operation, type KobrixaIR, type SourceSpan } from "@kobrixa/ir";
import type {
  PortWarning,
  PreparedSimulation,
  RobotConfig,
  SimulationScene,
} from "../shared/simulator.js";

/** First span of each literal motor letter and sensor number the program addresses. */
export function usedPorts(ir: KobrixaIR): {
  motors: Map<string, SourceSpan | undefined>;
  sensors: Map<string, SourceSpan | undefined>;
} {
  const motors = new Map<string, SourceSpan | undefined>(),
    sensors = new Map<string, SourceSpan | undefined>();
  for (const fn of ir.functions)
    for (const block of fn.blocks)
      for (const instruction of block.instructions) {
        if (instruction.op !== "ev3-call") continue;
        const category = getEV3Operation(instruction.operation)?.category;
        const [first] = instruction.args;
        // Variable ports are unknown before execution; only literals are checked.
        if (category === "motor" && first?.kind === "string")
          for (const letter of first.value.toUpperCase().match(/[A-D]/g) ?? [])
            if (!motors.has(letter)) motors.set(letter, instruction.span);
        if (
          category === "sensor" &&
          (first?.kind === "integer" || first?.kind === "number") &&
          [1, 2, 3, 4].includes(first.value) &&
          !sensors.has(String(first.value))
        )
          sensors.set(String(first.value), instruction.span);
      }
  return { motors, sensors };
}

function robotWarnings(robot: RobotConfig, ir: KobrixaIR): PortWarning[] {
  const { motors, sensors } = usedPorts(ir);
  const motorPorts = new Set<string>([
    ...robot.wheels.map((wheel) => wheel.port),
    ...(robot.shooter ? [robot.shooter.port] : []),
  ]);
  const sensorPorts = new Set(robot.sensors.map((sensor) => String(sensor.port)));
  const warning = (kind: PortWarning["kind"], port: string, span: SourceSpan | undefined) => ({
    robotId: robot.id,
    kind,
    port,
    ...(span ? { span } : {}),
  });
  return [
    ...[...motors]
      .filter(([port]) => !motorPorts.has(port))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([port, span]) => warning("motor", port, span)),
    ...[...sensors]
      .filter(([port]) => !sensorPorts.has(port))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([port, span]) => warning("sensor", port, span)),
  ];
}

/** Advisory only: a mismatch never blocks a run, it explains surprising readings. */
export function checkRobotPorts(
  scene: SimulationScene,
  prepared: PreparedSimulation,
): PortWarning[] {
  return scene.robots.flatMap((robot) => {
    if (robot.controller.kind !== "program") return [];
    const program = prepared.programs[robot.controller.entry];
    return program ? robotWarnings(robot, program.ir) : [];
  });
}
