import { describe, expect, it } from "vitest";
import type { SimulationScene, SimulationSensor } from "../shared/simulator.js";
import type { BuiltinOpponent } from "./opponent.js";
import { createDefaultScene, FIELD, normalizeDegrees } from "./scene.js";
import { SimulationWorld } from "./world.js";

function scene(): SimulationScene {
  const result = createDefaultScene();
  result.robots = [result.robots[0]!];
  const robot = result.robots[0]!;
  robot.controller = { kind: "builtin", level: "hard" };
  robot.pose = { x: 350, y: 850, heading: 0 };
  robot.pusher = null;
  robot.wheels[0]!.inverted = true;
  robot.sensors = [
    {
      port: 1,
      kind: "pixy2",
      x: 0,
      y: 0,
      angle: 0,
      range: 2500,
      fov: 120,
      pixy2: { height: 40, pitch: 0, verticalFov: 100, orangeSignature: 1, purpleSignature: 2 },
    },
    { port: 2, kind: "gyro", x: 0, y: 0, angle: 0, range: 0, fov: 0, inverted: true },
  ];
  result.balls = [];
  return result;
}

/** Inspect the controller's sensor-derived estimate without giving it access to world truth. */
function opponent(world: SimulationWorld): BuiltinOpponent {
  return (world as unknown as { robots: Map<string, { opponent: BuiltinOpponent }> }).robots
    .values()
    .next().value!.opponent;
}

function play(config: SimulationScene, ticks: number): SimulationWorld {
  const world = new SimulationWorld(config);
  world.run();
  world.advance(ticks);
  return world;
}

describe("builtin mounted sensors", () => {
  for (const team of ["A", "B"] as const) {
    it.each([0, 60, -135])(
      `restores inverted gyro direction for team ${team}, start %i°`,
      (heading) => {
        const config = scene();
        const robot = config.robots[0]!;
        robot.team = team;
        robot.pose.heading = heading;
        if (team === "B")
          robot.pose = {
            x: FIELD.width - robot.pose.x,
            y: FIELD.height - robot.pose.y,
            heading: normalizeDegrees(heading + 180),
          };
        const inverted = new SimulationWorld(config);
        const normalConfig = structuredClone(config);
        normalConfig.robots[0]!.sensors[1]!.inverted = false;
        const normal = new SimulationWorld(normalConfig);
        inverted.run();
        normal.run();
        for (let batch = 0; batch < 100; batch++) {
          inverted.advance(3);
          normal.advance(3);
          const actual = inverted.snapshot().robots[0]!.pose;
          expect(actual).toEqual(normal.snapshot().robots[0]!.pose);
          expect(opponent(inverted).estimate).toEqual(opponent(normal).estimate);
          // Sensor sample precedes this decision's physics tick, hence a small bounded lag.
          expect(
            Math.abs(normalizeDegrees(opponent(inverted).estimate.heading - actual.heading)),
          ).toBeLessThan(5);
        }
      },
    );
  }

  it.each([-60, 60])("uses Pixy2 orange blocks to steer toward lateral offset %i mm", (offset) => {
    const config = scene();
    config.balls = [{ id: "orange", kind: "orange", x: 650, y: 850 + offset, z: 20 }];
    const world = play(config, 20);
    const robot = world.snapshot().robots[0]!;
    expect(robot.pose.heading * Math.sign(offset)).toBeGreaterThan(5);
    expect(
      Math.abs(normalizeDegrees(opponent(world).estimate.heading - robot.pose.heading)),
    ).toBeLessThan(5);
  });

  it.each(["A", "B"] as const)(
    "team %s fires a visible orange using only its Pixy2 camera",
    (team) => {
      const config = scene();
      config.balls = [{ id: "orange", kind: "orange", x: 475, y: 850, z: 20 }];
      if (team === "B") {
        const robot = config.robots[0]!;
        robot.team = "B";
        robot.pose = { x: FIELD.width - 350, y: FIELD.height - 850, heading: 180 };
        config.balls[0]!.x = FIELD.width - 475;
        config.balls[0]!.y = FIELD.height - 850;
      }
      const state = play(config, 100).snapshot();
      expect(state.events.some((event) => event.message.includes("fired orange"))).toBe(true);
      const ownX = team === "A" ? state.balls[0]!.x : FIELD.width - state.balls[0]!.x;
      expect(ownX).toBeGreaterThan(600);
    },
  );

  it("centers a clipped block in a rotated camera without applying the mount angle twice", () => {
    const config = scene();
    Object.assign(config.robots[0]!.sensors[0]!, { angle: -25, fov: 20 });
    const bearing = (-14 * Math.PI) / 180; // +11° camera bearing, crossing the +10° image edge
    config.balls = [
      {
        id: "orange",
        kind: "orange",
        x: 350 + 300 * Math.cos(bearing),
        y: 850 + 300 * Math.sin(bearing),
        z: 20,
      },
    ];
    const state = play(config, 1).snapshot();
    expect(state.robots[0]!.pose.heading).toBeGreaterThan(0);
    expect(state.robots[0]!.pose.x).toBeCloseTo(350, 5);
    expect(state.debug!.device.motors.D.count).toBe(0);
    expect(state.events.some((event) => event.message.includes("fired"))).toBe(false);
  });

  it.each([-25, 25])("backs away from a nearby Pixy2 purple block at offset %i mm", (offset) => {
    const config = scene();
    config.balls = [{ id: "purple", kind: "purple", x: 475, y: 850 + offset, z: 20 }];
    const state = play(config, 20).snapshot();
    expect(state.robots[0]!.pose.x).toBeLessThan(340);
    expect(state.events.some((event) => event.message.includes("fired"))).toBe(false);
  });

  it("does not mistake a side-facing camera's purple block for a forward obstacle", () => {
    const config = scene();
    config.robots[0]!.pose = { x: 200, y: 860, heading: 0 };
    Object.assign(config.robots[0]!.sensors[0]!, { y: 75, angle: 90 });
    config.balls = [{ id: "purple", kind: "purple", x: 200, y: 1030, z: 20 }];
    const state = play(config, 1).snapshot();
    expect(state.robots[0]!.pose.x).toBeGreaterThan(200);
    expect(state.robots[0]!.pose.heading).toBeCloseTo(0, 5);
    expect(state.debug!.device.motors.D.count).toBe(0);
  });

  it.each(["untrained", "shared", "occluded", "missing"] as const)(
    "searches without inventing an orange observation when %s",
    (kind) => {
      const config = scene();
      const camera = config.robots[0]!.sensors[0]!;
      config.balls = [{ id: "orange", kind: "orange", x: 475, y: 850, z: 20 }];
      if (kind === "untrained") camera.pixy2!.orangeSignature = 0;
      if (kind === "shared") camera.pixy2!.orangeSignature = camera.pixy2!.purpleSignature;
      if (kind === "occluded") {
        config.robots[0]!.pose = { x: 1050, y: 850, heading: 0 };
        config.balls[0]!.x = 1600; // hidden behind the raised ramp's high face
      }
      if (kind === "missing") config.balls = [];
      const emptyConfig = structuredClone(config);
      emptyConfig.balls = [];
      const world = play(config, 1);
      const empty = play(emptyConfig, 1);
      expect(world.snapshot().robots[0]!.pose).toEqual(empty.snapshot().robots[0]!.pose);
      world.advance(100);
      expect(world.snapshot().events.some((event) => event.message.includes("fired"))).toBe(false);
      expect(world.snapshot().robots[0]!.distance).toBeGreaterThan(0);
    },
  );

  it("prefers installed synthetic vision when Pixy2 has no trained signatures", () => {
    const config = scene();
    config.robots[0]!.sensors[0]!.pixy2!.orangeSignature = 0;
    const vision: SimulationSensor = {
      port: 3,
      kind: "vision",
      x: 0,
      y: 0,
      angle: 0,
      range: 2500,
      fov: 120,
    };
    config.robots[0]!.sensors.push(vision);
    config.balls = [{ id: "orange", kind: "orange", x: 475, y: 850, z: 20 }];
    expect(
      play(config, 100)
        .snapshot()
        .events.some((event) => event.message.includes("fired orange")),
    ).toBe(true);
  });

  it("reproduces A1's reversed gyro and mounted Pixy2 without changing its saved configuration", () => {
    const config = scene();
    const robot = config.robots[0]!;
    robot.pose = { x: 100, y: 923, heading: 0 };
    robot.wheelTraction = "grip";
    Object.assign(robot.sensors[0]!, {
      x: 65,
      pixy2: {
        height: 100,
        pitch: -10,
        verticalFov: 40,
        orangeSignature: 1,
        purpleSignature: 2,
      },
    });
    robot.sensors.push(
      { port: 3, kind: "color", x: 75, y: 45, angle: 0, range: 5, fov: 0 },
      { port: 4, kind: "color", x: 75, y: -45, angle: 0, range: 5, fov: 0 },
    );
    robot.shooter!.port = "A";
    config.balls = [{ id: "orange", kind: "orange", x: 521, y: 923, z: 20 }];
    const before = structuredClone(config);
    const world = play(config, 100);
    expect(config).toEqual(before);
    const actual = world.snapshot().robots[0]!.pose;
    expect(
      Math.abs(normalizeDegrees(opponent(world).estimate.heading - actual.heading)),
    ).toBeLessThan(5);
    expect(actual.x).toBeGreaterThan(180);
    expect(Math.abs(actual.y - 923)).toBeLessThan(20);
  });
});
