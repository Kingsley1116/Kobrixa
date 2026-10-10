import type {
  RobotConfig,
  SimulationDrive,
  SimulationSensor,
  SimulationWheel,
} from "../shared/simulator.js";

/** Robot-local +x forward, +y left. Gear ratio is motor turns per wheel turn. */
export function createDriveWheels(drive: SimulationDrive): SimulationWheel[] {
  const wheel = (
    port: SimulationWheel["port"],
    x: number,
    y: number,
    angle: number,
  ): SimulationWheel => ({
    port,
    x,
    y,
    angle,
    diameter: 56,
    gearRatio: 1,
    inverted: false,
  });
  if (drive === "differential") return [wheel("B", 0, 60, 0), wheel("C", 0, -60, 0)];
  const count = drive === "omni3" ? 3 : 4;
  return Array.from({ length: count }, (_, index) => {
    const degrees = (index * 360) / count;
    const angle = (degrees * Math.PI) / 180;
    return wheel(
      (["A", "B", "C", "D"] as const)[index]!,
      Math.cos(angle) * 65,
      Math.sin(angle) * 65,
      degrees + 90,
    );
  });
}

export const ROBOT_PRESETS = ["driving-base", "wro"] as const;
export type RobotPresetId = (typeof ROBOT_PRESETS)[number];
/** Everything a preset decides; identity, controller and start pose stay with the robot. */
export type RobotHardware = Pick<
  RobotConfig,
  | "drive"
  | "width"
  | "length"
  | "mass"
  | "wheels"
  | "wheelTraction"
  | "sensors"
  | "pusher"
  | "shooter"
>;

export function robotHardware(id: RobotPresetId): RobotHardware {
  if (id === "driving-base")
    // LEGO Education core set Driving Base: large motors on B (left) and C (right).
    return {
      drive: "differential",
      width: 130,
      length: 180,
      mass: 0.9,
      wheels: createDriveWheels("differential"),
      sensors: [
        { port: 1, kind: "touch", x: 95, y: 0, angle: 0, range: 5, fov: 0 },
        { port: 2, kind: "gyro", x: 0, y: 0, angle: 0, range: 0, fov: 0 },
        { port: 3, kind: "color", x: 70, y: 0, angle: 0, range: 5, fov: 0 },
        { port: 4, kind: "ultrasonic", x: 90, y: 0, angle: 0, range: 2550, fov: 30 },
      ],
      pusher: null,
      shooter: null,
    };
  return {
    drive: "differential",
    width: 150,
    length: 160,
    mass: 1,
    wheels: createDriveWheels("differential"),
    sensors: [
      { port: 1, kind: "color", x: 65, y: 0, angle: 0, range: 5, fov: 0 },
      { port: 2, kind: "ultrasonic", x: 75, y: 0, angle: 0, range: 2550, fov: 30 },
      { port: 3, kind: "gyro", x: 0, y: 0, angle: 0, range: 0, fov: 0 },
      { port: 4, kind: "vision", x: 75, y: 0, angle: 0, range: 2500, fov: 120 },
    ],
    pusher: { width: 120, depth: 15 },
    shooter: {
      port: "D",
      x: 95,
      y: 0,
      angle: 0,
      elevation: 20,
      stroke: 180,
      speed: 1700,
      range: 75,
    },
  };
}

export function applyRobotPreset(robot: RobotConfig, id: RobotPresetId): RobotConfig {
  const { wheelTraction, ...hardware } = robotHardware(id);
  const next: RobotConfig = { ...robot, ...hardware };
  // Presets use the default traction, which scenes store by omitting the field.
  delete next.wheelTraction;
  return { ...next, ...(wheelTraction ? { wheelTraction } : {}) };
}

function canonicalSensor(sensor: SimulationSensor) {
  return [
    sensor.port,
    sensor.kind,
    sensor.x,
    sensor.y,
    sensor.angle,
    sensor.range,
    sensor.fov,
    sensor.inverted ?? false,
    sensor.pixy2
      ? [
          sensor.pixy2.height,
          sensor.pixy2.pitch,
          sensor.pixy2.verticalFov,
          sensor.pixy2.orangeSignature,
          sensor.pixy2.purpleSignature,
        ]
      : null,
  ];
}
function canonicalHardware(hardware: RobotHardware): string {
  return JSON.stringify([
    hardware.drive,
    hardware.width,
    hardware.length,
    hardware.mass,
    hardware.wheels.map((w) => [w.port, w.x, w.y, w.angle, w.diameter, w.gearRatio, w.inverted]),
    hardware.wheelTraction ?? "slip",
    [...hardware.sensors].sort((a, b) => a.port - b.port).map(canonicalSensor),
    hardware.pusher && [hardware.pusher.width, hardware.pusher.depth],
    hardware.shooter && [
      hardware.shooter.port,
      hardware.shooter.x,
      hardware.shooter.y,
      hardware.shooter.angle,
      hardware.shooter.elevation,
      hardware.shooter.stroke,
      hardware.shooter.speed,
      hardware.shooter.range,
    ],
  ]);
}

/** Any edit away from a preset's exact hardware reads as "custom". */
export function detectRobotPreset(robot: RobotConfig): RobotPresetId | "custom" {
  const current = canonicalHardware(robot);
  return ROBOT_PRESETS.find((id) => canonicalHardware(robotHardware(id)) === current) ?? "custom";
}
