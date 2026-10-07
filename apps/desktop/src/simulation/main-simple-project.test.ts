import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadProject, type SourceProject } from "@kobrixa/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import {
  prepareSimulation,
  snapshotSimulationAssets,
} from "../main/workspace/prepare-simulation.js";
import type { SimulationScene } from "../shared/simulator.js";
import { validateScene } from "./scene.js";
import { normalizeDegrees, SimulationWorld } from "./world.js";

const root = process.env.KOBRIXA_MAIN_SIMPLE_PROJECT;
const entry = "Main_Simple_L_2026.bp";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// These tests use the real, unchanged competition helpers without distributing
// private sources. All entry/scene overrides exist in memory, including when the
// user's saved A1 currently runs a built-in opponent.
describe.skipIf(!root)("Main_Simple project contract", () => {
  let project: SourceProject;
  let savedScene: SimulationScene;
  let scenePath: string;
  let sceneDigest: string;
  let files: Record<string, number[]>;
  beforeAll(async () => {
    const loaded = await loadProject(root!);
    expect(loaded.diagnostics).toEqual([]);
    project = loaded.project!;
    scenePath =
      process.env.KOBRIXA_MAIN_SIMPLE_SCENE ?? path.join(project.root, "kobrixa.simulator.json");
    const sceneText = await readFile(scenePath, "utf8");
    sceneDigest = digest(sceneText);
    savedScene = validateScene(JSON.parse(sceneText));
    files = await snapshotSimulationAssets(project);
  });

  function programScene(): SimulationScene {
    const scene = structuredClone(savedScene);
    scene.mode = "practice";
    scene.robots.find((robot) => robot.id === "A1")!.controller = { kind: "program", entry };
    return scene;
  }

  async function prepare(source?: string) {
    const captured =
      source === undefined
        ? project
        : {
            ...project,
            sources: project.sources.map((file) =>
              file.path === entry ? { ...file, content: source } : file,
            ),
          };
    const result = await prepareSimulation(captured, [entry], files, new AbortController().signal);
    expect(result.success, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.success) throw new Error("Main_Simple preparation failed");
    return result.prepared;
  }

  function advance(world: SimulationWorld, ticks: number) {
    for (let tick = 0; tick < ticks; tick++) {
      world.advance(1);
      const state = world.snapshot();
      expect(state.status, JSON.stringify(state.events.at(-1))).not.toBe("error");
      if (state.status === "paused") world.run();
    }
  }

  it.each([
    { name: "forward", command: "move(40, 40)", direction: 1 },
    { name: "reverse", command: "move(-40, -40)", direction: -1 },
  ])("maps $name encoder coordinates to physical travel", async ({ command, direction }) => {
    const scene = programScene();
    scene.robots = [scene.robots.find((robot) => robot.id === "A1")!];
    scene.robots[0]!.pose = { x: 400, y: 850, heading: 0 };
    scene.balls = [];
    const world = new SimulationWorld(
      scene,
      await prepare(
        probe(`
${command}
Program.Delay(300)
MotorBC.OffAndBrake()
`),
      ),
    );
    world.run();
    advance(world, 65);
    const state = world.snapshot();
    const robot = state.robots[0]!;
    const debug = state.debug!;
    expect(debug.globals.probe_done).toBe(true);
    expect((robot.pose.x - 400) * direction).toBeGreaterThan(30);
    expect(robot.pose.y).toBeCloseTo(850, 3);
    expect(robot.pose.heading).toBeCloseTo(0, 3);
    expect(Number(debug.globals.x)).toBeCloseTo(700, 2);
    const encoderSum = -debug.device.motors.B.count + debug.device.motors.C.count;
    const programTravel = Number(debug.globals.y) - 1000;
    expect(programTravel * direction).toBeGreaterThan(100);
    // GetTacho returns integer degrees; the odometry loop may leave <2 degrees.
    expect(Math.abs(programTravel - encoderSum)).toBeLessThan(4);
    const wheel = scene.robots[0]!.wheels[0]!;
    const mmPerSummedDegree = (Math.PI * wheel.diameter) / (720 * wheel.gearRatio);
    expect(robot.pose.x - 400).toBeCloseTo(encoderSum * mmPerSummedDegree, 2);
    expect(Math.abs(programTravel - (robot.pose.x - 400))).toBeGreaterThan(50);
  });

  it.each([
    { name: "left", command: "turn(25)\nProgram.Delay(180)", direction: 1 },
    { name: "right", command: "turn(-25)\nProgram.Delay(180)", direction: -1 },
    { name: "gyro left", command: "turn_gyro(45, 2)", direction: 1 },
    { name: "gyro right", command: "turn_gyro(-45, 2)", direction: -1 },
  ])(
    "keeps $name turn, installed gyro and helper heading consistent",
    async ({ command, direction }) => {
      const scene = programScene();
      scene.robots = [scene.robots.find((robot) => robot.id === "A1")!];
      scene.robots[0]!.pose = { x: 400, y: 850, heading: 0 };
      scene.balls = [];
      const world = new SimulationWorld(
        scene,
        await prepare(probe(`${command}\nMotorBC.OffAndBrake()`)),
      );
      world.run();
      advance(world, 160);
      const state = world.snapshot();
      expect(state.debug!.globals.probe_done).toBe(true);
      const heading = state.robots[0]!.pose.heading;
      expect(heading * direction).toBeGreaterThan(10);
      expect(state.robots[0]!.distance).toBeLessThan(1);
      const raw = Number(state.debug!.device.sensors[2].raw[0]);
      expect(Math.abs(normalizeDegrees(raw + heading))).toBeLessThan(1.1);
      expect(Math.abs(normalizeDegrees(Number(state.debug!.globals.rpx) - heading))).toBeLessThan(
        1.1,
      );
    },
  );

  it.each([-1, 1])("move_gyro corrects a heading error with sign %i", async (direction) => {
    const scene = programScene();
    scene.robots = [scene.robots.find((robot) => robot.id === "A1")!];
    scene.robots[0]!.pose = { x: 400, y: 850, heading: 0 };
    scene.balls = [];
    const world = new SimulationWorld(
      scene,
      await prepare(
        probe(`
turn(${direction * 25})
Program.Delay(180)
MotorBC.OffAndBrake()
Program.Delay(50)
probe_heading_before = rpx
Time.Reset4()
While Time.Get4() < 500
  move_gyro(2, 20, 0)
EndWhile
MotorBC.OffAndBrake()
`),
      ),
    );
    world.run();
    advance(world, 105);
    const state = world.snapshot();
    expect(state.debug!.globals.probe_done).toBe(true);
    const before = Number(state.debug!.globals.probe_heading_before);
    expect(before * direction).toBeGreaterThan(10);
    expect(Math.abs(state.robots[0]!.pose.heading)).toBeLessThan(Math.abs(before) / 3);
    expect(state.robots[0]!.pose.x).toBeGreaterThan(425);
    expect((Number(state.debug!.globals.x) - 700) * direction).toBeGreaterThan(5);
    expect(Number(state.debug!.globals.y)).toBeGreaterThan(1100);
  });

  it("progresses through real route states and recovers after collision for 180 seconds", async () => {
    const scene = programScene();
    const world = new SimulationWorld(scene, await prepare());
    world.run();
    world.advance(170);
    expect(world.snapshot().debug?.globals.gyroresetresult).toBe("True");
    world.buttons("A1", ["enter"]);
    world.buttons("A1", []);
    const labels = project.sources
      .find((file) => file.path === entry)!
      .content.split(/\r?\n/)
      .flatMap((line, index) => {
        const match = line.match(/^(State_[A-Z_]+):/);
        return match ? [{ name: match[1]!, line: index + 1 }] : [];
      });
    const states = new Set<string>();
    const collisionIds = new Set<number>();
    let reverseAfterCollision = false;
    let backwardsDistance = 0;
    let previous = world.snapshot().robots.find((robot) => robot.id === "A1")!.pose;
    let maxBlockedMs = 0;
    let continuations = 0;
    while (world.timeMs < 180_000) {
      world.advance(10);
      const state = world.snapshot();
      expect(state.status, JSON.stringify(state.events.at(-1))).not.toBe("error");
      if (state.status === "paused") {
        continuations++;
        world.run();
      } else expect(state.status).toBe("running");
      const debug = state.debug!;
      const motors = debug.device.motors;
      const pose = state.robots.find((robot) => robot.id === "A1")!.pose;
      for (const event of state.events)
        if (
          event.kind === "collision" &&
          event.robotId === "A1" &&
          /wall|barrier|ramp/.test(event.message)
        )
          collisionIds.add(event.id);
      if (collisionIds.size && motors.B.speed > 0 && motors.C.speed < 0)
        reverseAfterCollision = true;
      if (reverseAfterCollision) {
        const theta = (previous.heading * Math.PI) / 180;
        backwardsDistance += Math.max(
          0,
          -(pose.x - previous.x) * Math.cos(theta) - (pose.y - previous.y) * Math.sin(theta),
        );
      }
      previous = pose;
      const span = debug.currentSpan;
      if (span?.file === entry) {
        const label = [...labels].reverse().find((label) => label.line <= span.start.line);
        if (label) states.add(label.name);
      }
      const lastMovement = Number(debug.globals.last_time);
      if (Math.abs(motors.B.speed) + Math.abs(motors.C.speed) > 20 && lastMovement > 0) {
        maxBlockedMs = Math.max(maxBlockedMs, state.timeMs - lastMovement);
        expect(
          maxBlockedMs,
          `Route stalled at ${state.timeMs} ms with Y=${debug.globals.y}; ${JSON.stringify(debug.currentSpan)}`,
        ).toBeLessThan(2000);
      }
    }
    const state = world.snapshot();
    expect(state.debug!.instructions).toBeGreaterThan(10_000_000);
    expect(state.robots.find((robot) => robot.id === "A1")!.distance).toBeGreaterThan(15_000);
    expect(state.debug!.globals.last_time).toBeGreaterThan(175_000);
    expect(collisionIds.size).toBeGreaterThan(0);
    expect(reverseAfterCollision).toBe(true);
    expect(backwardsDistance).toBeGreaterThan(100);
    expect([...states]).toEqual(
      expect.arrayContaining(["State_FIRST", "State_BACK", "State_SECOND"]),
    );
    // Loading/testing a different controller must never save over the user's scene
    // or quietly patch the competition helpers to make the route pass.
    expect(digest(await readFile(scenePath, "utf8"))).toBe(sceneDigest);
    for (const source of project.sources)
      expect(digest(await readFile(path.join(project.root, source.path), "utf8"))).toBe(
        digest(source.content),
      );
    console.info("Main_Simple route regression", {
      elapsedMs: state.timeMs,
      maxBlockedMs,
      continuations,
      states: [...states],
      collisions: collisionIds.size,
      backwardsDistanceMm: Math.round(backwardsDistance),
    });
  }, 30_000);
});

function probe(command: string): string {
  return `include "Init"
include "Move_3"
include "Sensor"
Gyro.reset(2)
X = 700
Y = 1000
Thread.Run = Sub_Gyro
Thread.Run = Sub_is_stuck
Program.Delay(100)
${command}
Program.Delay(100)
probe_done = True
While 1
  Program.Delay(10)
EndWhile
`;
}
