import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { setImmediate as yieldToRunner } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type {
  OpponentLevel,
  PreparedSimulation,
  RobotConfig,
  SimulationScene,
} from "../shared/simulator.js";
import {
  createDefaultScene,
  createDriveWheels,
  createPracticeScene,
  FIELD,
  PRACTICE_FIELD,
  randomizeBalls,
  rollMatchDuration,
  validateScene,
} from "./scene.js";
import { driveVelocity, matColor, SimulationWorld } from "./world.js";

async function prepare(source: string, entry = "main.bp"): Promise<PreparedSimulation> {
  const compiled = await new BasicPlusFrontend().compile(
    {
      root: "/simulation",
      manifest: {
        schemaVersion: 1,
        name: "simulation",
        language: "bp",
        entry,
        target: "ev3-native",
        assets: [],
        outputDir: "build",
      },
      sources: [{ path: entry, content: source }],
      assets: [],
    },
    new AbortController().signal,
  );
  expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  return { programs: { [entry]: { ir: compiled.ir!, files: {} } } };
}
function scene(): SimulationScene {
  const result = createDefaultScene("main.bp");
  result.robots = [result.robots[0]!];
  result.robots[0]!.pose = { x: 300, y: 200, heading: 0 };
  result.balls = [];
  result.durationMs = 10_000;
  return result;
}
const idle = "While 1\nProgram.Delay(10)\nEndWhile\n";
async function world(source: string, config = scene()): Promise<SimulationWorld> {
  return new SimulationWorld(config, await prepare(source));
}

describe("solid ramp volume", () => {
  it.each([0, 1])("climbs and reverses down ramp %i through its low edge", async (index) => {
    const config = scene();
    const ramp = FIELD.ramps[index]!;
    const robot = config.robots[0]!;
    robot.team = index === 0 ? "A" : "B";
    robot.pusher = null;
    robot.pose = {
      x: ramp.direction === 1 ? ramp.x - 50 : ramp.x + ramp.width + 50,
      y: ramp.y + 250,
      heading: ramp.direction === 1 ? 0 : 180,
    };
    const simulation = await world(
      'Motor.Start("BC", 50)\nProgram.Delay(1000)\nMotor.Start("BC", -50)\n' + idle,
      config,
    );
    simulation.run();
    simulation.advance(100);
    const top = simulation.snapshot();
    expect(top.status).toBe("running");
    expect(top.robots[0]!.elevation).toBeGreaterThan(15);
    expect(top.robots[0]!.elevation).toBeLessThan(30);
    expect(top.events.filter((event) => event.kind === "collision")).toEqual([]);
    simulation.advance(100);
    expect(simulation.snapshot().robots[0]!.elevation).toBe(0);
    expect(simulation.snapshot().robots[0]!.pose.x).toBeCloseTo(robot.pose.x, 1);
  });

  it.each([0, 1])(
    "blocks the vertical high face of ramp %i without lifting the robot",
    async (index) => {
      const config = scene();
      const ramp = FIELD.ramps[index]!;
      const robot = config.robots[0]!;
      robot.team = index === 0 ? "B" : "A";
      robot.pusher = null;
      robot.wheelTraction = "grip";
      const face = ramp.direction === 1 ? ramp.x + ramp.width : ramp.x;
      robot.pose = {
        x: face + ramp.direction * 200,
        y: ramp.y + 250,
        heading: ramp.direction === 1 ? 180 : 0,
      };
      const simulation = await world('Motor.Start("BC", 100)\n' + idle, config);
      simulation.run();
      simulation.advance(300);
      const state = simulation.snapshot();
      expect(state.status).toBe("running");
      expect((state.robots[0]!.pose.x - face) * ramp.direction).toBeGreaterThan(75);
      expect(state.robots[0]!.elevation).toBe(0);
      expect(
        state.events.some((event) => event.kind === "collision" && event.message.includes("ramp")),
      ).toBe(true);
      const count = state.debug!.device.motors.B.count;
      simulation.advance(30);
      expect(simulation.snapshot().debug!.device.motors.B.count - count).toBeLessThan(2);
    },
  );

  it("uses ramp volume for ultrasound and vision, and raises mounted sensors with the chassis", async () => {
    const config = scene();
    const robot = config.robots[0]!;
    robot.pose = { x: 1050, y: 850, heading: 0 };
    robot.sensors = [
      { port: 1, kind: "ultrasonic", x: 0, y: 0, angle: 0, range: 1000, fov: 0 },
      { port: 2, kind: "vision", x: 0, y: 0, angle: 0, range: 2000, fov: 120 },
      {
        port: 3,
        kind: "pixy2",
        x: 0,
        y: 0,
        angle: 0,
        range: 2000,
        fov: 120,
        pixy2: { height: 40, pitch: 0, verticalFov: 80, orangeSignature: 1, purpleSignature: 2 },
      },
    ];
    config.balls = [{ id: "hidden", kind: "orange", x: 1600, y: 850, z: 20 }];
    const low = await world(idle, config);
    expect(low.snapshot().debug!.device.sensors[1].si[0]).toBeCloseTo(13.1, 4);
    expect(low.snapshot().debug!.device.sensors[2].si).toEqual([0, 0, 0, 0]);
    expect(low.snapshot().debug!.device.sensors[3].si[0]).toBe(0);
    robot.sensors[2]!.pixy2!.height = 200;
    const raised = await world(idle, config);
    expect(raised.snapshot().debug!.device.sensors[3].si[0]).toBeGreaterThan(0);

    // A horizontal ultrasound ray meets the slope at z=40 mm, not its low edge.
    robot.pose = { x: 700, y: 250, heading: 0 };
    config.balls = [];
    const slope = await world(idle, config);
    expect(slope.snapshot().debug!.device.sensors[1].si[0]).toBeCloseTo(42.1, 4);
    // On the ramp, the same probe is now above the high end rather than inside it.
    robot.pose.x = 1031;
    const atop = await world(idle, config);
    expect(atop.snapshot().robots[0]!.elevation).toBe(25);
    expect(atop.snapshot().debug!.device.sensors[1].si[0]).toBe(100);
  });

  it.each([0, 60])(
    "blocks a low shot and lets a raised shot clear the high ramp face (%i°)",
    async (elevation) => {
      const config = scene();
      config.robots[0]!.pose = { x: 900, y: 850, heading: 0 };
      Object.assign(config.robots[0]!.shooter!, { stroke: 5, elevation, speed: 3000 });
      config.balls = [{ id: "shot", kind: "orange", x: 1020, y: 850, z: 20 }];
      const simulation = await world('Motor.Move("D", 100, 10, true)\n' + idle, config);
      simulation.run();
      let farthest = 0;
      for (let tick = 0; tick < 30; tick++) {
        simulation.advance();
        farthest = Math.max(farthest, simulation.snapshot().balls[0]!.x);
      }
      if (elevation === 0) {
        expect(farthest).toBeLessThan(1165);
        expect(simulation.snapshot().balls[0]!.z).toBe(20);
      } else {
        expect(farthest).toBeGreaterThan(1400);
        expect(simulation.snapshot().balls[0]!.z).toBeGreaterThan(70);
      }
    },
  );

  it("rolls a pushed ball up the slope and lets gravity roll a free ball back down", async () => {
    const config = scene();
    config.robots[0]!.pose = { x: 740, y: 250, heading: 0 };
    config.balls = [{ id: "pushed", kind: "orange", x: 870, y: 250, z: 20 }];
    const simulation = await world('Motor.Start("BC", 50)\n' + idle, config);
    simulation.run();
    simulation.advance(160);
    expect(simulation.snapshot().balls[0]!.x).toBeGreaterThan(1000);
    expect(simulation.snapshot().balls[0]!.z).toBeGreaterThan(40);
    config.robots[0]!.controller = { kind: "disabled" };
    config.balls = [{ id: "rolling", kind: "orange", x: 1031, y: 250, z: 45 }];
    const free = new SimulationWorld(config);
    free.run();
    free.advance(100);
    expect(free.snapshot().balls[0]!.x).toBeLessThan(881);
    expect(free.snapshot().balls[0]!.z).toBeCloseTo(20, 1);
  });
});

describe("simulation scene and wheel geometry", () => {
  it("implements the official mirrored four coin tosses and one purple choice", () => {
    const balls = randomizeBalls(2026);
    expect(balls).toHaveLength(11);
    expect(balls.filter((ball) => ball.kind === "orange")).toHaveLength(9);
    expect(balls.filter((ball) => ball.kind === "purple")).toHaveLength(2);
    for (const left of balls.filter((ball) => ball.id.includes("-A"))) {
      const right = balls.find((ball) => ball.id === left.id.replace("-A", "-B"))!;
      expect(right).toMatchObject({
        x: FIELD.width - left.x,
        y: FIELD.height - left.y,
        kind: left.kind,
      });
    }
    expect(randomizeBalls(2026)).toEqual(balls);
    expect(randomizeBalls(55)).not.toEqual(balls);
    expect([70_000, 80_000, 90_000, 100_000, 110_000, 120_000]).toContain(rollMatchDuration(2026));
    expect(validateScene(createDefaultScene())).toEqual(createDefaultScene());
  });
  it("rejects nonfinite data, unsafe entries, duplicate ports and shared drive/shooter outputs", () => {
    const config = scene();
    config.robots[0]!.pose.x = Infinity;
    expect(() => validateScene(config)).toThrow();
    config.robots[0]!.pose.x = 300;
    config.robots[0]!.controller = { kind: "program", entry: "../main.bp" };
    expect(() => validateScene(config)).toThrow(/project-relative/);
    config.robots[0]!.controller = { kind: "program", entry: "main.bp" };
    config.robots[0]!.drive = "omni4";
    config.robots[0]!.wheels = createDriveWheels("omni4");
    expect(() => validateScene(config)).toThrow(/free motor port/);
    config.robots[0]!.shooter = null;
    expect(() => validateScene(config)).not.toThrow();
    config.robots[0]!.wheels[1]!.port = "A";
    expect(() => validateScene(config)).toThrow(/unique/);
  });
  it.each(["differential", "omni3", "omni4"] as const)(
    "solves %s wheel constraints for forward motion",
    (drive) => {
      const robot = scene().robots[0]!;
      robot.drive = drive;
      robot.wheels = createDriveWheels(drive);
      const deltas = Object.fromEntries(
        robot.wheels.map((wheel) => [
          wheel.port,
          ((150 * Math.cos((wheel.angle * Math.PI) / 180) * 0.01) / (Math.PI * wheel.diameter)) *
            360,
        ]),
      );
      const velocity = driveVelocity(robot, deltas);
      expect(velocity.x).toBeCloseTo(150, 7);
      expect(velocity.y).toBeCloseTo(0, 7);
      expect(velocity.angular).toBeCloseTo(0, 7);
    },
  );
  it("rejects ambiguous robot ID/name aliases and durations between fixed ticks", () => {
    const config = createDefaultScene();
    config.robots[1]!.name = "Partner";
    config.robots[0]!.name = config.robots[1]!.id;
    expect(() => validateScene(config)).toThrow(/Ambiguous/);
    config.robots[0]!.name = config.robots[0]!.id;
    config.durationMs = 10001;
    expect(() => validateScene(config)).toThrow(/multiple/);
  });
  it.each(["omni3", "omni4"] as const)("solves %s lateral motion and rotation", (drive) => {
    const robot = scene().robots[0]!;
    robot.drive = drive;
    robot.wheels = createDriveWheels(drive);
    const deltas = Object.fromEntries(
      robot.wheels.map((wheel) => {
        const angle = (wheel.angle * Math.PI) / 180;
        const speed =
          Math.sin(angle) * 100 + (-wheel.y * Math.cos(angle) + wheel.x * Math.sin(angle)) * 0.5;
        return [wheel.port, ((speed * 0.01) / (Math.PI * wheel.diameter)) * 360];
      }),
    );
    expect(driveVelocity(robot, deltas)).toMatchObject({
      x: expect.closeTo(0, 7),
      y: expect.closeTo(100, 7),
      angular: expect.closeTo(0.5, 7),
    });
  });
});

describe("fixed-time multi-robot world", () => {
  it.each(["slip", "grip"] as const)(
    "uses %s wheel traction at a wall and can reverse away with mirrored motor wiring",
    async (traction) => {
      const config = scene();
      const robot = config.robots[0]!;
      robot.pose = { x: 250, y: 200, heading: 180 };
      robot.pusher = null;
      robot.wheelTraction = traction;
      robot.wheels[0]!.inverted = true;
      const simulation = await world(
        `
MotorB.StartPower(-50)
MotorC.StartPower(50)
Program.Delay(1600)
before = MotorB.GetTacho()
Program.Delay(200)
delta = Math.Abs(MotorB.GetTacho() - before)
Motor.ResetCount("BC")
MotorB.StartPower(50)
MotorC.StartPower(-50)
Program.Delay(1000)
MotorBC.OffAndBrake()
`,
        config,
      );
      simulation.run();
      simulation.advance(290);
      const state = simulation.snapshot();
      expect(state.robots[0]!.status).toBe("completed");
      expect(state.robots[0]!.pose.x).toBeGreaterThan(230);
      expect(Math.abs(state.robots[0]!.pose.heading)).toBeCloseTo(180, 2);
      const delta = state.debug!.globals.delta as number;
      if (traction === "grip") expect(delta).toBeLessThan(2);
      else expect(delta).toBeGreaterThan(60);
      expect(state.debug!.device.motors.B.count).toBeCloseTo(360, 0);
      expect(state.events.some((event) => event.kind === "collision")).toBe(true);
    },
  );

  it("reverses gyro angle and rate for a reversed installation", async () => {
    const config = scene();
    config.robots[0]!.sensors = [
      { port: 2, kind: "gyro", x: 0, y: 0, angle: 0, range: 0, fov: 0, inverted: true },
    ];
    const simulation = await world(
      'Sensor.SetMode(2, 3)\nMotor.Start("B", -20)\nMotor.Start("C", 20)\n' + idle,
      config,
    );
    simulation.run();
    simulation.advance(100);
    const state = simulation.snapshot();
    expect(state.debug!.device.sensors[2].si[0]).toBeCloseTo(-state.robots[0]!.pose.heading, 3);
    expect(state.debug!.device.sensors[2].si[1]).toBeLessThan(0);
  });
  it("moves by shaft turns and does not teleport when encoder counts are reset", async () => {
    const simulation = await world(
      'Motor.Start("BC", 50)\nProgram.Delay(500)\nMotor.ResetCount("BC")\n' + idle,
    );
    simulation.run();
    simulation.advance(100);
    const robot = simulation.snapshot().robots[0]!;
    expect(robot.pose.x).toBeCloseTo(300 + Math.PI * 56, 3);
    expect(robot.pose.y).toBeCloseTo(200, 6);
    expect(robot.distance).toBeCloseTo(Math.PI * 56, 3);
    expect(simulation.snapshot().debug!.device.motors.B.count).toBeCloseTo(180, 1);
  });
  it("turns a differential robot on the spot", async () => {
    const simulation = await world('Motor.Start("B", -50)\nMotor.Start("C", 50)\n' + idle);
    simulation.run();
    simulation.advance(100);
    const pose = simulation.snapshot().robots[0]!.pose;
    expect(pose.x).toBeCloseTo(300, 5);
    expect(pose.y).toBeCloseTo(200, 5);
    expect(pose.heading).toBeCloseTo(168, 3);
  });
  it.each(["omni3", "omni4"] as const)(
    "moves an actual %s chassis sideways without turning",
    async (drive) => {
      const config = scene();
      const robot = config.robots[0]!;
      robot.drive = drive;
      robot.wheels = createDriveWheels(drive);
      robot.shooter = null;
      const code =
        drive === "omni3"
          ? 'Motor.Start("A", 40)\nMotor.Start("BC", -20)\n'
          : 'Motor.Start("A", 40)\nMotor.Start("C", -40)\n';
      const simulation = await world(code + idle, config);
      simulation.run();
      simulation.advance(100);
      const pose = simulation.snapshot().robots[0]!.pose;
      expect(pose.x).toBeCloseTo(300, 4);
      expect(pose.y).toBeCloseTo(200 + Math.PI * 56 * 0.8, 3);
      expect(pose.heading).toBeCloseTo(0, 5);
    },
  );
  it("prevents robot tunnelling through the wall and barrier", async () => {
    const config = scene();
    config.robots[0]!.pose = { x: 650, y: 400, heading: 90 };
    const simulation = await world('Motor.Start("BC", 100)\n' + idle, config);
    simulation.run();
    simulation.advance(300);
    expect(simulation.snapshot().robots[0]!.pose.y).toBeLessThan(490);
    expect(simulation.snapshot().events.some((event) => event.kind === "collision")).toBe(true);
    const boundary = scene();
    boundary.robots[0]!.pose = { x: 150, y: 200, heading: 180 };
    const wall = await world('Motor.Start("BC", 100)\n' + idle, boundary);
    wall.run();
    wall.advance(300);
    expect(wall.snapshot().robots[0]!.pose.x).toBeGreaterThan(90);
  });
  it("runs four programs with equal deterministic quotas and resets to identical initial state", async () => {
    const config = createDefaultScene("main.bp");
    config.balls = [];
    config.robots.forEach((robot) => {
      robot.controller = { kind: "program", entry: "main.bp" };
    });
    const prepared = await prepare("counter = 0\nWhile 1\ncounter = counter + 1\nEndWhile");
    const first = new SimulationWorld(config, prepared),
      second = new SimulationWorld(config, prepared);
    first.run();
    second.run();
    first.advance(250);
    for (let i = 0; i < 25; i++) second.advance(10);
    expect(first.snapshot()).toEqual(second.snapshot());
    const counts = config.robots.map((robot) => {
      first.select(robot.id);
      return first.snapshot().debug!.instructions;
    });
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(250_000);
    first.pause();
    first.advance(50);
    expect(first.timeMs).toBe(2500);
    first.step();
    expect(first.timeMs).toBe(2510);
    expect(first.status).toBe("paused");
  });
  it("stops match at its exact tick boundary while practice continues with a visible marker", async () => {
    const config = scene();
    config.mode = "match";
    const match = await world(idle, config);
    match.run();
    match.advance(1000);
    expect(match.status).toBe("completed");
    expect(match.timeMs).toBe(10_000);
    match.advance(20);
    expect(match.timeMs).toBe(10_000);
    config.mode = "practice";
    const practice = await world(idle, config);
    practice.run();
    practice.advance(1000);
    practice.advance(1);
    expect(practice.snapshot()).toMatchObject({
      status: "running",
      timeMs: 10_010,
      practiceContinuation: true,
    });
  });
  it("reports a program failure and stops all motors without touching other execution services", async () => {
    const simulation = await world('Motor.Start("BC", 100)\nEV3.SystemCall("no host access")\n');
    simulation.run();
    simulation.advance(1);
    const snapshot = simulation.snapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.events.at(-1)).toMatchObject({ kind: "error", robotId: "A1" });
    expect(snapshot.debug!.device.motors.B.speed).toBe(0);
  });
  it("pauses when only the pusher overlaps red, and resumes as training without repeated pauses", async () => {
    const config = scene();
    config.mode = "match";
    // Chassis ends at1128; the15mm pusher crosses the red band beginning1131.
    config.robots[0]!.pose = { x: 1048, y: 200, heading: 0 };
    const simulation = await world(idle, config);
    simulation.run();
    simulation.advance(10);
    expect(simulation.timeMs).toBe(10);
    expect(simulation.status).toBe("paused");
    expect(simulation.snapshot().events.at(-1)!.message).toContain("red ramp");
    simulation.run();
    simulation.advance(1000);
    expect(simulation.snapshot()).toMatchObject({ status: "running", practiceContinuation: true });
    expect(simulation.snapshot().events.filter((event) => event.kind === "violation")).toHaveLength(
      1,
    );
  });
  it("marks a single-step after a violation as training and still ends ordinary stepped matches", async () => {
    const config = scene();
    config.mode = "match";
    config.robots[0]!.pose = { x: 1048, y: 200, heading: 0 };
    const violation = await world(idle, config);
    violation.step();
    expect(violation.snapshot().practiceContinuation).toBe(false);
    violation.step();
    expect(violation.snapshot()).toMatchObject({
      status: "paused",
      practiceContinuation: true,
      timeMs: 20,
    });
    const clean = scene();
    clean.mode = "match";
    const match = await world(idle, clean);
    match.run();
    match.advance(999);
    match.pause();
    match.step();
    expect(match.snapshot()).toMatchObject({
      status: "completed",
      timeMs: 10_000,
      practiceContinuation: false,
    });
  });
  it("excludes disabled robots from collisions and sensor occlusion", async () => {
    const config = scene();
    const disabled = structuredClone(config.robots[0]!);
    disabled.id = disabled.name = "A2";
    disabled.controller = { kind: "disabled" };
    disabled.pose = { x: 500, y: 200, heading: 0 };
    config.robots.push(disabled);
    config.balls = [{ id: "orange", kind: "orange", x: 700, y: 200, z: 20 }];
    const simulation = await world('Motor.Start("BC", 50)\n' + idle, config);
    expect(simulation.snapshot().debug!.device.sensors[4].si[0]).toBe(1);
    simulation.run();
    simulation.advance(100);
    expect(simulation.snapshot().robots[0]!.pose.x).toBeGreaterThan(475);
    expect(simulation.snapshot().events.filter((event) => event.kind === "collision")).toHaveLength(
      0,
    );
  });
});

describe("environment sensors and balls", () => {
  it("samples mat lines and all three ramp bands", () => {
    expect(matColor(521, 923)).toEqual([0, 0, 0]);
    expect(matColor(300, 200)).toEqual([255, 255, 255]);
    expect(matColor(900, 200)).toEqual([133, 188, 87]);
    expect(matColor(1080, 200)).toEqual([0, 112, 192]);
    expect(matColor(1160, 200)).toEqual([255, 0, 0]);
    expect(matColor(1200, 1000)).toEqual([255, 0, 0]);
  });
  it("reads vision bearing/range, mode filters, and no-detection sentinel through existing sensor calls", async () => {
    const config = scene();
    config.balls = [
      { id: "orange", kind: "orange", x: 525, y: 200, z: 20 },
      { id: "purple", kind: "purple", x: 600, y: 300, z: 20 },
    ];
    const simulation = await world("Sensor.SetMode(4, 2)\n" + idle, config);
    simulation.run();
    simulation.advance(1);
    const reading = simulation.snapshot().debug!.device.sensors[4];
    expect(reading.name).toBe("KOBRIXA-VISION");
    expect(reading.si[0]).toBe(1);
    expect(reading.si[3]).toBe(2);
    expect(reading.si[1]).toBeCloseTo((Math.atan2(100, 225) * 180) / Math.PI, 3);
    expect(reading.si[2]).toBeCloseTo(Math.hypot(225, 100), 3);
    const empty = await world(idle);
    expect(empty.snapshot().debug!.device.sensors[4].si).toEqual([0, 0, 0, 0]);
  });
  it("occludes vision behind another robot and gives ultrasonic distance to the obstacle", async () => {
    const config = scene();
    const obstacle: RobotConfig = structuredClone(config.robots[0]!);
    obstacle.id = obstacle.name = "A2";
    obstacle.controller = { kind: "program", entry: "main.bp" };
    obstacle.pose = { x: 500, y: 200, heading: 0 };
    config.robots.push(obstacle);
    config.balls = [{ id: "orange", kind: "orange", x: 650, y: 200, z: 20 }];
    const simulation = await world(idle, config);
    const inputs = simulation.snapshot().debug!.device.sensors;
    expect(inputs[4].si).toEqual([0, 0, 0, 0]);
    expect(inputs[2].si[0]).toBeCloseTo(4.5, 5);
  });
  it("keeps central orange uncounted until moved, counts purple -2, and scores the geometric half", async () => {
    const config = scene();
    config.balls = randomizeBalls(2026);
    const simulation = await world(idle, config);
    expect(simulation.snapshot().score).toEqual({ A: 2, B: 2 });
    config.balls = [
      { id: "orange", kind: "orange", x: 700, y: 300, z: 20 },
      { id: "purple", kind: "purple", x: 1900, y: 300, z: 20 },
    ];
    expect((await world(idle, config)).snapshot().score).toEqual({ A: 1, B: -2 });
  });
  it("counts and drops a central ball manually repositioned away from its starting spot", async () => {
    const config = scene();
    config.balls = [{ id: "orange-central", kind: "orange", x: 700, y: 300, z: 70, central: true }];
    const simulation = await world(idle, config);
    expect(simulation.snapshot().score).toEqual({ A: 1, B: 0 });
    simulation.run();
    simulation.advance(100);
    expect(simulation.snapshot().balls[0]!.z).toBeCloseTo(20, 3);
  });
  it("lets a builtin opponent hold a close orange target through its shooter stroke", () => {
    const config = scene();
    config.robots[0]!.controller = { kind: "builtin" };
    config.balls = [{ id: "orange", kind: "orange", x: 425, y: 200, z: 20 }];
    const simulation = new SimulationWorld(config);
    simulation.run();
    simulation.advance(50);
    expect(
      simulation.snapshot().events.some((event) => event.message.includes("fired orange")),
    ).toBe(true);
    expect(simulation.snapshot().balls[0]!.x).toBeGreaterThan(500);
  });
  it("makes builtin opponents avoid nearby purple balls and refuse shots toward their own half", () => {
    const config = scene();
    config.robots[0]!.controller = { kind: "builtin" };
    config.balls = [{ id: "purple", kind: "purple", x: 425, y: 200, z: 20 }];
    const avoiding = new SimulationWorld(config);
    avoiding.run();
    avoiding.advance(20);
    expect(avoiding.snapshot().robots[0]!.pose.x).toBeLessThan(290);
    expect(avoiding.snapshot().events.some((event) => event.message.includes("fired"))).toBe(false);
    config.robots[0]!.pose.heading = 180;
    config.balls = [{ id: "orange", kind: "orange", x: 175, y: 200, z: 20 }];
    const wrongWay = new SimulationWorld(config);
    wrongWay.run();
    wrongWay.advance(20);
    expect(wrongWay.snapshot().events.some((event) => event.message.includes("fired"))).toBe(false);
  });
  it("fires only after a motor stroke and moves the ball in a visible ballistic arc", async () => {
    const config = scene();
    config.balls = [{ id: "orange", kind: "orange", x: 425, y: 200, z: 20 }];
    const simulation = await world('Motor.Move("D", 100, 180, true)\n' + idle, config);
    simulation.run();
    simulation.advance(24);
    expect(simulation.snapshot().balls[0]!.x).toBeCloseTo(425, 3);
    simulation.advance(5);
    const ball = simulation.snapshot().balls[0]!;
    expect(ball.x).toBeGreaterThan(470);
    expect(ball.z).toBeGreaterThan(25);
    expect(
      simulation.snapshot().events.some((event) => event.message.includes("fired orange")),
    ).toBe(true);
  });
  it("pushes a ball against the opposing ramp face without passing through it", async () => {
    const config = scene();
    config.robots[0]!.pose = { x: 1000, y: 780, heading: 0 };
    config.balls = [{ id: "orange", kind: "orange", x: 1120, y: 780, z: 20 }];
    const simulation = await world('Motor.Start("BC", 100)\n' + idle, config);
    simulation.run();
    simulation.advance(300);
    expect(simulation.status).toBe("running");
    expect(simulation.snapshot().balls[0]!.x).toBeGreaterThan(1120);
    expect(simulation.snapshot().balls[0]!.x).toBeLessThan(1165);
    expect(simulation.snapshot().balls[0]!.z).toBe(20);
    expect(
      simulation
        .snapshot()
        .events.some((event) => event.kind === "violation" && event.robotId === "A1"),
    ).toBe(false);
  });
  it.each(["orange", "purple"] as const)(
    "returns an out-of-field %s ball to the proper team's corner and pauses",
    async (kind) => {
      const config = scene();
      config.robots[0]!.pose = { x: 170, y: 300, heading: 180 };
      Object.assign(config.robots[0]!.shooter!, { stroke: 5, elevation: 60, speed: 5000 });
      config.balls = [{ id: "shot", kind, x: 40, y: 300, z: 70 }];
      const simulation = await world('Motor.Move("D", 100, 10, true)\n' + idle, config);
      simulation.run();
      simulation.advance(100);
      expect(simulation.status).toBe("paused");
      expect(simulation.snapshot().balls[0]).toMatchObject({
        x: kind === "orange" ? 40 : FIELD.width - 40,
        y: 40,
        z: 20,
      });
      expect(
        simulation.snapshot().events.some((event) => event.message.includes("returned to team")),
      ).toBe(true);
      simulation.run();
      simulation.advance(5);
      expect(simulation.status).toBe("running");
    },
  );
  it("lets an elevated shot clear the physical barrier", async () => {
    const config = scene();
    config.robots[0]!.pose = { x: 700, y: 430, heading: 90 };
    Object.assign(config.robots[0]!.shooter!, { stroke: 5, elevation: 60, speed: 3000 });
    config.balls = [{ id: "shot", kind: "orange", x: 700, y: 550, z: 70 }];
    const simulation = await world('Motor.Move("D", 100, 10, true)\n' + idle, config);
    simulation.run();
    simulation.advance(10);
    expect(simulation.snapshot().balls[0]!.y).toBeGreaterThan(680);
    expect(simulation.snapshot().balls[0]!.z).toBeGreaterThan(150);
  });
  it("reads gyro angle and rate from physical rotation", async () => {
    const simulation = await world(
      'Sensor.SetMode(3, 3)\nMotor.Start("B", -50)\nMotor.Start("C", 50)\n' + idle,
    );
    simulation.run();
    simulation.advance(50);
    const si = simulation.snapshot().debug!.device.sensors[3].si;
    expect(si[0]).toBeCloseTo(84, 3);
    expect(si[1]).toBeCloseTo(168, 3);
  });
  it("detects a pressed touch probe even when its tip is inside the wall fixture", async () => {
    const config = scene();
    config.robots[0]!.pose = { x: 80, y: 200, heading: 180 };
    config.robots[0]!.sensors = [
      { port: 1, kind: "touch", x: 82, y: 0, angle: 0, range: 10, fov: 0 },
    ];
    const simulation = await world(idle, config);
    expect(simulation.snapshot().debug!.device.sensors[1].si).toEqual([1]);
  });
  it("assigns a ball touching a robot to that robot's team even across the dividing line", async () => {
    const config = scene();
    config.robots[0]!.pose = { x: 1078, y: 780, heading: 0 };
    config.balls = [{ id: "contact", kind: "orange", x: 1190, y: 780, z: 70 }];
    const simulation = await world(idle, config);
    expect(simulation.snapshot().score).toEqual({ A: 0, B: 1 });
    simulation.run();
    simulation.advance(1);
    expect(simulation.snapshot().score).toEqual({ A: 1, B: 0 });
  });
});

describe("builtin opponent", () => {
  function opponents(
    seed: number,
    levels: { A: OpponentLevel; B: OpponentLevel },
  ): SimulationScene {
    const config = createDefaultScene("main.bp");
    config.seed = seed;
    config.balls = randomizeBalls(seed);
    config.mode = "match";
    config.durationMs = 90_000;
    config.robots = config.robots.map((robot) => ({
      ...robot,
      controller: { kind: "builtin", level: levels[robot.team] },
    }));
    return config;
  }
  /** Plays to the end, resuming after rule pauses; returns the violations that occurred. */
  function play(simulation: SimulationWorld, untilMs = Infinity): string[] {
    simulation.run();
    while (["running", "paused"].includes(simulation.status) && simulation.timeMs < untilMs) {
      if (simulation.status === "paused") simulation.run();
      simulation.advance(100);
    }
    return simulation
      .snapshot()
      .events.filter((event) => event.kind === "violation")
      .map((event) => event.message);
  }

  it.each(["easy", "standard", "hard"] as const)(
    "keeps four %s robots out of the opponent half and red ramp bands for a whole match",
    async (level) => {
      for (const seed of [2026, 7919]) {
        // Full matches are CPU-bound. Let pending test-runner RPC replies arrive
        // between seeds instead of starving them across consecutive CI matches.
        await yieldToRunner();
        const simulation = new SimulationWorld(opponents(seed, { A: level, B: level }));
        expect(play(simulation)).toEqual([]);
        expect(simulation.status).toBe("completed");
        expect(
          simulation.snapshot().events.filter((event) => event.message.includes("fired")).length,
        ).toBeGreaterThan(3);
      }
    },
    // Two full four-robot matches need more than the default 5 s on CI runners.
    60_000,
  );

  it("keeps advanced levels ahead of easy, allowing hard/standard draws with the same hardware", async () => {
    for (const [strong, weak] of [
      ["hard", "easy"],
      ["standard", "easy"],
      ["hard", "standard"],
    ] as const) {
      let margin = 0;
      for (const seed of [11, 2026, 7919, 31337]) {
        await yieldToRunner();
        const simulation = new SimulationWorld(opponents(seed, { A: strong, B: weak }));
        play(simulation);
        margin += simulation.snapshot().score.B - simulation.snapshot().score.A;
      }
      // The default 1700 mm/s, 20° launcher cannot clear a 50 mm face from
      // ground level. Hard and standard can both exhaust reachable lower-lane
      // balls and draw; requiring a win rewarded the old ramp penetration bug.
      if (weak === "standard") expect(margin, `${strong} vs ${weak}`).toBeGreaterThanOrEqual(0);
      else expect(margin, `${strong} vs ${weak}`).toBeGreaterThan(0);
    }
  }, 60_000);

  it("patrols its half instead of spinning in place when it sees no ball", () => {
    const config = scene();
    config.robots[0]!.controller = { kind: "builtin" };
    const simulation = new SimulationWorld(config);
    play(simulation, 8_000);
    const robot = simulation.snapshot().robots[0]!;
    const xs = robot.trace.map((point) => point.x),
      ys = robot.trace.map((point) => point.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(300);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(300);
    expect(Math.max(...xs)).toBeLessThan(FIELD.midX);
  });

  it("bank-shots a ball resting against its own back wall", () => {
    const config = scene();
    config.robots[0]!.controller = { kind: "builtin", level: "hard" };
    config.robots[0]!.pose = { x: 400, y: 400, heading: 0 };
    config.balls = [{ id: "orange", kind: "orange", x: 30, y: 250, z: 20 }];
    const simulation = new SimulationWorld(config);
    play(simulation, 10_000);
    expect(simulation.snapshot().events.some((event) => event.message.includes("fired"))).toBe(
      true,
    );
    expect(simulation.snapshot().balls[0]!.x).toBeGreaterThan(300);
  });

  it("is reproducible for the same scene", () => {
    const run = () => {
      const simulation = new SimulationWorld(opponents(99, { A: "hard", B: "standard" }));
      play(simulation, 20_000);
      const snapshot = simulation.snapshot();
      return { robots: snapshot.robots.map((robot) => robot.pose), balls: snapshot.balls };
    };
    expect(run()).toEqual(run());
  });

  it("accepts scenes saved before levels existed and rejects unknown levels", () => {
    const config = scene();
    config.robots[0]!.controller = { kind: "builtin" };
    expect(validateScene(config).robots[0]!.controller).toEqual({ kind: "builtin" });
    (config.robots[0]!.controller as { level?: string }).level = "nightmare";
    expect(() => validateScene(config)).toThrow(/level/);
  });
});

describe("practice field", () => {
  function practice(): SimulationScene {
    const result = createPracticeScene("main.bp");
    result.durationMs = 10_000;
    return result;
  }

  it("has no barrier or ramps: a robot drives straight across at floor level", async () => {
    const config = practice();
    // Starts inside ramp 0's footprint and drives through the barrier towards ramp 1.
    config.robots[0]!.pose = { x: 1100, y: 300, heading: 90 };
    const simulation = await world('Motor.Start("BC", 50)\n' + idle, config);
    expect(simulation.snapshot().events[0]!.message).toBe(
      "Practice field · simplified local physics.",
    );
    simulation.run();
    let maxElevation = 0;
    for (let i = 0; i < 30; i++) {
      simulation.advance(10);
      maxElevation = Math.max(maxElevation, simulation.snapshot().robots[0]!.elevation);
    }
    const state = simulation.snapshot();
    expect(state.status).toBe("running");
    expect(maxElevation).toBe(0);
    expect(state.robots[0]!.pose.y).toBeGreaterThan(FIELD.barrier.y + FIELD.barrier.height + 150);
    expect(state.robots[0]!.pose.x).toBeCloseTo(1100, 0);
    expect(state.events.filter((event) => event.kind !== "info")).toEqual([]);
  });

  it("reads the loop line as black and the rest of the mat as white", async () => {
    const { loop } = PRACTICE_FIELD;
    expect(matColor(1000, loop.y, "practice")).toEqual([0, 0, 0]);
    expect(matColor(1000, loop.y + loop.height, "practice")).toEqual([0, 0, 0]);
    expect(matColor(loop.x, 570, "practice")).toEqual([0, 0, 0]);
    expect(matColor(1000, 570, "practice")).toEqual([255, 255, 255]);
    expect(matColor(1160, 200, "practice")).toEqual([255, 255, 255]);
    expect(matColor(-1, 200, "practice")).toEqual([0, 0, 0]);
    // The default sampler is still the WRO mat.
    expect(matColor(1160, 200)).toEqual([255, 0, 0]);

    const reading = async (y: number) => {
      const config = practice();
      config.robots[0]!.pose = { x: 600, y, heading: 0 };
      const simulation = await world("Sensor.SetMode(3, 2)\n" + idle, config);
      simulation.run();
      simulation.advance(1);
      return simulation.snapshot().debug!.device.sensors[3].si[0];
    };
    expect(await reading(PRACTICE_FIELD.start.y)).toBe(1);
    expect(await reading(570)).toBe(6);
  });

  it("allows crossing the midline but still pauses when the robot leaves the mat", async () => {
    const config = practice();
    config.robots[0]!.pose = { x: FIELD.midX - 200, y: 570, heading: 0 };
    const crossing = await world('Motor.Start("BC", 50)\n' + idle, config);
    crossing.run();
    crossing.advance(200);
    const crossed = crossing.snapshot();
    expect(crossed.status).toBe("running");
    expect(crossed.robots[0]!.pose.x).toBeGreaterThan(FIELD.midX + 100);
    expect(crossed.events.filter((event) => event.kind === "violation")).toEqual([]);

    // A wall-less push past the edge is not physically possible, so start overhanging it.
    const edge = practice();
    edge.robots[0]!.pose = { x: 60, y: 570, heading: 0 };
    const leaving = await world(idle, edge);
    leaving.run();
    leaving.advance(1);
    const left = leaving.snapshot();
    expect(left.status).toBe("paused");
    expect(left.events.at(-1)).toMatchObject({ kind: "violation", robotId: "A1" });
    expect(left.events.at(-1)!.message).toContain("left the mat");
  });

  it("ignores the match duration", async () => {
    const simulation = await world(idle, practice());
    simulation.run();
    simulation.advance(1000);
    simulation.advance(10);
    const state = simulation.snapshot();
    expect(state).toMatchObject({ status: "running", timeMs: 10_100, practiceContinuation: false });
    expect(state.events.some((event) => event.message.includes("Match time elapsed"))).toBe(false);
  });
});
