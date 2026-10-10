import { z } from "zod";
import type { PreviewPort } from "../preview/virtual-device.js";
import {
  OPPONENT_LEVELS,
  SIMULATION_TICK_MS,
  type RobotConfig,
  type SimulationBall,
  type SimulationRuleset,
  type SimulationScene,
  type SimulationWheel,
} from "../shared/simulator.js";
import { robotHardware } from "./robot-presets.js";

/** International WRO Double Tennis 2026, millimetres; origin at mat bottom-left. */
export const FIELD = {
  width: 2362,
  height: 1143,
  midX: 1181,
  midY: 571.5,
  ballRadius: 20,
  wallHeight: 50,
  barrier: { x: 400, y: 563, width: 1562, height: 17, elevation: 50 },
  ramps: [
    { x: 881, y: 0, width: 300, height: 563, direction: 1, elevation: 50 },
    { x: 1181, y: 580, width: 300, height: 563, direction: -1, elevation: 50 },
  ],
  leftLines: [923, 683, 360, 120],
  rightLines: [220, 460, 783, 1023],
  verticalLines: [
    { x: 143, width: 20 },
    { x: 851, width: 60 },
    { x: 1511, width: 60 },
    { x: 2219, width: 20 },
  ],
  starts: [
    { x: 100, y: 923, heading: 0, team: "A" },
    { x: 100, y: 360, heading: 0, team: "A" },
    { x: 2262, y: 220, heading: 180, team: "B" },
    { x: 2262, y: 783, heading: 180, team: "B" },
  ],
} as const;

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x4b4f4252;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/** Four orange coin tosses and one purple line selection, mirrored between teams. */
export function randomizeBalls(seed: number): SimulationBall[] {
  const random = seededRandom(seed);
  const choices = FIELD.leftLines.map(() => (random() < 0.5 ? 521 : 671));
  const purpleLine = Math.floor(random() * 4);
  const left = FIELD.leftLines.map((y, index): SimulationBall => ({
    id: `orange-A-${index + 1}`,
    kind: "orange",
    x: choices[index]!,
    y,
    z: 20,
  }));
  left.push({
    id: "purple-A",
    kind: "purple",
    x: choices[purpleLine] === 521 ? 671 : 521,
    y: FIELD.leftLines[purpleLine]!,
    z: 20,
  });
  const right = left.map((ball): SimulationBall => ({
    ...ball,
    id: ball.id.replace("-A", "-B"),
    x: FIELD.width - ball.x,
    y: FIELD.height - ball.y,
  }));
  return [
    ...left,
    ...right,
    { id: "orange-central", kind: "orange", x: FIELD.midX, y: FIELD.midY, z: 70, central: true },
  ];
}

export function rollMatchDuration(seed: number): number {
  return 60_000 + (1 + Math.floor(seededRandom(seed ^ 0x6d617463)() * 6)) * 10_000;
}

export { createDriveWheels } from "./robot-presets.js";

/** Practice mat: same table as WRO, one black rounded-rectangle loop on white. */
export const PRACTICE_FIELD = {
  loop: { x: 400, y: 250, width: 1562, height: 643, radius: 200, lineWidth: 20 },
  start: { x: 600, y: 250, heading: 0 },
} as const;

/** Unsigned distance in mm from a mat point to the practice loop's centre line. */
export function practiceLineDistance(x: number, y: number): number {
  const { loop } = PRACTICE_FIELD;
  const halfX = loop.width / 2,
    halfY = loop.height / 2;
  const qx = Math.abs(x - (loop.x + halfX)) - (halfX - loop.radius);
  const qy = Math.abs(y - (loop.y + halfY)) - (halfY - loop.radius);
  const signed =
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - loop.radius;
  return Math.abs(signed);
}

export function createPracticeScene(entry = "src/main.bp"): SimulationScene {
  return {
    version: 1,
    ruleset: "practice",
    mode: "practice",
    seed: 2026,
    durationMs: 600_000,
    balls: [],
    robots: [
      {
        id: "A1",
        name: "A1",
        team: "A",
        controller: { kind: "program", entry },
        pose: { ...PRACTICE_FIELD.start },
        ...robotHardware("driving-base"),
      },
    ],
  };
}

export function createSceneForField(ruleset: SimulationRuleset, entry?: string): SimulationScene {
  return ruleset === "practice" ? createPracticeScene(entry) : createDefaultScene(entry);
}

export function createDefaultScene(entry = "src/main.bp"): SimulationScene {
  const seed = 2026;
  return {
    version: 1,
    ruleset: "wro-double-tennis-2026",
    mode: "practice",
    seed,
    durationMs: rollMatchDuration(seed),
    balls: randomizeBalls(seed),
    robots: FIELD.starts.map((start, index): RobotConfig => ({
      id: `${start.team}${(index % 2) + 1}`,
      name: `${start.team}${(index % 2) + 1}`,
      team: start.team,
      controller: index === 0 ? { kind: "program", entry } : { kind: "disabled" },
      pose: { x: start.x, y: start.y, heading: start.heading },
      ...robotHardware("wro"),
    })),
  };
}

const finite = z.number().finite();
const position = finite.min(-5000).max(5000);
const port = z.enum(["A", "B", "C", "D"]);
const poseSchema = z
  .object({ x: position, y: position, heading: finite.min(-36000).max(36000) })
  .strict();
const wheelSchema = z
  .object({
    port,
    x: position,
    y: position,
    angle: finite.min(-36000).max(36000),
    diameter: finite.min(10).max(150),
    gearRatio: finite.min(0.1).max(100),
    inverted: z.boolean(),
  })
  .strict();
const sensorSchema = z
  .object({
    port: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    kind: z.enum(["color", "ultrasonic", "gyro", "touch", "vision", "pixy2"]),
    x: position,
    y: position,
    angle: finite.min(-36000).max(36000),
    range: finite.min(0).max(5000),
    fov: finite.min(0).max(360),
    inverted: z.boolean().optional(),
    pixy2: z
      .object({
        height: finite.min(0).max(500),
        pitch: finite.min(-89).max(89),
        verticalFov: finite.min(1).max(170),
        orangeSignature: finite.int().min(0).max(7),
        purpleSignature: finite.int().min(0).max(7),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((sensor) => sensor.kind !== "pixy2" || (sensor.fov >= 1 && sensor.fov <= 170), {
    message: "Pixy2 horizontal field of view must be between 1 and 170 degrees",
    path: ["fov"],
  });
const robotSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    name: z.string().trim().min(1).max(32),
    team: z.enum(["A", "B"]),
    controller: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("program"),
          entry: z
            .string()
            .min(1)
            .max(512)
            .refine(
              (value) =>
                !value.startsWith("/") &&
                !value.includes("\\") &&
                !value.includes("\0") &&
                !value.split("/").some((part) => part === ".." || part === "." || !part) &&
                /\.bp$/i.test(value),
              "Entry must be a project-relative .bp path",
            ),
        })
        .strict(),
      z
        .object({
          kind: z.literal("builtin"),
          level: z.enum(OPPONENT_LEVELS).optional(),
        })
        .strict(),
      z.object({ kind: z.literal("disabled") }).strict(),
    ]),
    pose: poseSchema,
    drive: z.enum(["differential", "omni3", "omni4"]),
    width: finite.min(40).max(200),
    length: finite.min(40).max(200),
    mass: finite.min(0.1).max(1.2),
    wheels: z.array(wheelSchema).min(2).max(4),
    wheelTraction: z.enum(["slip", "grip"]).optional(),
    sensors: z.array(sensorSchema).max(4),
    pusher: z
      .object({ width: finite.min(10).max(200), depth: finite.min(1).max(80) })
      .strict()
      .nullable(),
    shooter: z
      .object({
        port,
        x: position,
        y: position,
        angle: finite.min(-36000).max(36000),
        elevation: finite.min(0).max(80),
        stroke: finite.min(1).max(3600),
        speed: finite.min(100).max(5000),
        range: finite.min(10).max(200),
      })
      .strict()
      .nullable(),
  })
  .strict();
const sceneSchema = z
  .object({
    version: z.literal(1),
    ruleset: z.enum(["practice", "wro-double-tennis-2026"]),
    mode: z.enum(["practice", "match"]),
    seed: finite.int().min(0).max(0xffff_ffff),
    durationMs: finite.int().min(10_000).max(600_000).multipleOf(10),
    robots: z.array(robotSchema).min(1).max(4),
    balls: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/),
            kind: z.enum(["orange", "purple"]),
            x: position,
            y: position,
            z: finite.min(20).max(2000),
            central: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export function validateScene(value: unknown): SimulationScene {
  const parsed = sceneSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  const scene: SimulationScene = parsed.data;
  const unique = (values: (string | number)[], message: string) => {
    if (new Set(values).size !== values.length) throw new Error(message);
  };
  unique(
    scene.robots.map((robot) => robot.id),
    "Robot IDs must be unique.",
  );
  unique(
    scene.robots.map((robot) => robot.name),
    "Robot communication names must be unique.",
  );
  const aliases = new Map<string, string>();
  for (const robot of scene.robots)
    for (const alias of new Set([robot.id, robot.name])) {
      if (aliases.has(alias) && aliases.get(alias) !== robot.id)
        throw new Error(`Ambiguous robot communication name '${alias}'.`);
      aliases.set(alias, robot.id);
    }
  unique(
    scene.balls.map((ball) => ball.id),
    "Ball IDs must be unique.",
  );
  if (scene.ruleset === "practice") {
    if (scene.robots.length !== 1)
      throw new Error("The practice field supports exactly one robot.");
    if (scene.robots[0]!.controller.kind === "builtin")
      throw new Error("The practice field has no built-in opponents.");
    if (scene.balls.length) throw new Error("The practice field has no balls.");
  }
  for (const team of ["A", "B"] as const)
    if (scene.robots.filter((robot) => robot.team === team).length > 2)
      throw new Error("Each team supports at most two robots.");
  for (const robot of scene.robots) {
    unique(
      robot.wheels.map((wheel) => wheel.port),
      `${robot.name}: drive ports must be unique.`,
    );
    unique(
      robot.sensors.map((sensor) => sensor.port),
      `${robot.name}: sensor ports must be unique.`,
    );
    if (robot.wheels.length !== { differential: 2, omni3: 3, omni4: 4 }[robot.drive])
      throw new Error(`${robot.name}: wheel count does not match the drive preset.`);
    if (robot.shooter && robot.wheels.some((wheel) => wheel.port === robot.shooter!.port))
      throw new Error(
        `${robot.name}: shooter requires a free motor port; four-wheel drive uses all ports.`,
      );
    if (
      robot.pose.x < 0 ||
      robot.pose.x > FIELD.width ||
      robot.pose.y < 0 ||
      robot.pose.y > FIELD.height
    )
      throw new Error(`${robot.name}: starting position must be on the mat.`);
    if (
      robot.drive === "differential" &&
      (Math.abs(robot.wheels[0]!.y - robot.wheels[1]!.y) < 10 ||
        robot.wheels.some((wheel) => Math.abs(Math.sin((wheel.angle * Math.PI) / 180)) > 0.01))
    )
      throw new Error(
        `${robot.name}: differential wheels must be parallel to the chassis with at least 10 mm track width.`,
      );
    if (robot.drive !== "differential") {
      const rows = robot.wheels.map((wheel) => wheelRow(wheel));
      if (Math.abs(determinant(normalMatrix(rows))) < 1e-8)
        throw new Error(`${robot.name}: wheel geometry cannot produce omnidirectional motion.`);
    }
  }
  for (const ball of scene.balls)
    if (ball.x < 0 || ball.x > FIELD.width || ball.y < 0 || ball.y > FIELD.height)
      throw new Error(`${ball.id}: starting position must be on the mat.`);
  return scene;
}

export function wheelRow(wheel: SimulationWheel): [number, number, number] {
  const angle = (wheel.angle * Math.PI) / 180;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [c, s, -wheel.y * c + wheel.x * s];
}
export function normalMatrix(rows: number[][]): number[][] {
  return Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => rows.reduce((sum, row) => sum + row[i]! * row[j]!, 0)),
  );
}
export function determinant(m: number[][]): number {
  return (
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!)
  );
}

const DEG = Math.PI / 180;
export const normalizeDegrees = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;

/** Solve wheel constraints in millimetres/second and radians/second. */
export function driveVelocity(
  robot: RobotConfig,
  shaftDegrees: Partial<Record<PreviewPort, number>>,
  elapsedSeconds = SIMULATION_TICK_MS / 1000,
): { x: number; y: number; angular: number } {
  const speeds = robot.wheels.map(
    (wheel) =>
      ((((shaftDegrees[wheel.port] ?? 0) / elapsedSeconds / 360) * Math.PI * wheel.diameter) /
        wheel.gearRatio) *
      (wheel.inverted ? -1 : 1),
  );
  if (robot.drive === "differential") {
    const [left, right] = robot.wheels;
    const l = speeds[0]! * Math.cos(left!.angle * DEG);
    const r = speeds[1]! * Math.cos(right!.angle * DEG);
    const angular = (r - l) / (left!.y - right!.y);
    return { x: l + angular * left!.y, y: 0, angular };
  }
  const rows = robot.wheels.map(wheelRow);
  const matrix = normalMatrix(rows);
  const rhs = [0, 1, 2].map((axis) =>
    rows.reduce((sum, row, i) => sum + row[axis]! * speeds[i]!, 0),
  );
  const det = determinant(matrix);
  if (Math.abs(det) < 1e-8) throw new Error("Invalid omnidirectional wheel geometry.");
  const values = [0, 1, 2].map(
    (axis) =>
      determinant(matrix.map((row, i) => row.map((value, j) => (j === axis ? rhs[i]! : value)))) /
      det,
  );
  return { x: values[0]!, y: values[1]!, angular: values[2]! };
}
