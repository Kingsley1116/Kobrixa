import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend, inspectRbf } from "@kobrixa/backend-ev3";
import { loadProject } from "@kobrixa/compiler";
import type { PreparedSimulation, SimulationScene } from "../shared/simulator.js";
import { VirtualDevice } from "../preview/virtual-device.js";
import { PreviewRuntime } from "../preview/runtime.js";
import { validateScene } from "./scene.js";
import { SimulationWorld } from "./world.js";

const examplesRoot = fileURLToPath(new URL("../../../../examples/simulation/", import.meta.url));
const names = [
  "differential-route",
  "omni-lateral",
  "vision-search",
  "pixy2-search",
  "motor-shooter",
  "mailbox-cooperation",
];
const cache = new Map<string, { scene: SimulationScene; prepared: PreparedSimulation }>();

async function prepare(name: string) {
  const cached = cache.get(name);
  if (cached) return cached;
  const root = path.join(examplesRoot, name);
  const scene = validateScene(
    JSON.parse(await readFile(path.join(root, "kobrixa.simulator.json"), "utf8")),
  );
  const loaded = await loadProject(root);
  expect(loaded.diagnostics, name).toEqual([]);
  const prepared: PreparedSimulation = { programs: {} };
  for (const robot of scene.robots) {
    if (robot.controller.kind !== "program" || prepared.programs[robot.controller.entry]) continue;
    const entry = robot.controller.entry;
    const source = await readFile(path.join(root, entry), "utf8");
    const front = await new BasicPlusFrontend().compile(
      {
        ...loaded.project!,
        manifest: { ...loaded.project!.manifest, entry },
        sources: [{ path: entry, content: source }],
      },
      new AbortController().signal,
    );
    expect(front.diagnostics, `${name}/${entry}`).toEqual([]);
    expect(front.ir).toBeDefined();
    const back = await new EV3Backend().compile(front.ir!, new AbortController().signal);
    expect(back.diagnostics, `${name}/${entry}`).toEqual([]);
    expect(inspectRbf(back.rbf!).objectCount).toBeGreaterThan(0);
    prepared.programs[entry] = { ir: front.ir!, files: {} };
  }
  const result = { scene, prepared };
  cache.set(name, result);
  return result;
}

async function worldFor(name: string): Promise<SimulationWorld> {
  const { scene, prepared } = await prepare(name);
  const world = new SimulationWorld(scene, prepared);
  world.run();
  return world;
}

describe("shipped 2D simulation lessons", () => {
  it.each(names)("compiles every configured entry and ships bilingual notes: %s", async (name) => {
    const result = await prepare(name);
    expect(Object.keys(result.prepared.programs).length).toBe(
      name === "mailbox-cooperation" ? 2 : 1,
    );
    const readme = await readFile(path.join(examplesRoot, name, "README.md"), "utf8");
    expect(readme).toContain("Expected result / 預期結果");
  });

  it("drives the differential L route and stops near its geometric endpoint", async () => {
    const world = await worldFor("differential-route");
    world.advance(600);
    const state = world.snapshot();
    expect(state.status).not.toBe("error");
    expect(state.robots[0]?.status).toBe("completed");
    expect(state.robots[0]!.pose.x).toBeCloseTo(602, -1);
    expect(state.robots[0]!.pose.y).toBeCloseTo(926, -1);
    expect(state.robots[0]!.pose.heading).toBeCloseTo(90, 0);
    expect(state.debug?.device.motors.B.speed).toBe(0);
    expect(state.debug?.device.events.some((event) => event.detail === "Route complete")).toBe(
      true,
    );
  });

  it("slides the omni chassis sideways while its heading stays fixed", async () => {
    const world = await worldFor("omni-lateral");
    world.advance(105);
    const first = world.snapshot();
    expect(first.robots[0]!.pose.x).toBeCloseTo(300, 0);
    expect(first.robots[0]!.pose.y).toBeCloseTo(891, 0);
    expect(first.robots[0]!.pose.heading).toBeCloseTo(0, 1);
    world.advance(400);
    const last = world.snapshot();
    expect(last.robots[0]?.status).toBe("completed");
    expect(last.robots[0]!.pose.x).toBeGreaterThan(435);
    expect(last.robots[0]!.pose.heading).toBeGreaterThan(45);
  });

  it("searches with a limited view and reaches the orange target instead of the purple distractor", async () => {
    const world = await worldFor("vision-search");
    world.advance(900);
    const state = world.snapshot();
    expect(state.status).not.toBe("error");
    expect(state.robots[0]?.status).toBe("completed");
    expect(state.debug?.globals.found).toBe(true);
    expect(state.robots[0]!.pose.x).toBeGreaterThan(480);
    expect(state.debug?.device.events.some((event) => event.detail === "Orange ball found")).toBe(
      true,
    );
  });

  it("reads Pixy2 signature blocks through the native I2C API without moving", async () => {
    const world = await worldFor("pixy2-search");
    world.advance(250);
    const state = world.snapshot();
    expect(state.status).not.toBe("error");
    expect(state.robots[0]?.status).toBe("completed");
    expect(state.robots[0]!.distance).toBe(0);
    expect(state.debug?.globals.count).toBe(1);
    expect(state.debug?.globals.width).toBeGreaterThan(0);
    expect(state.debug?.globals.height).toBeGreaterThan(0);
    expect(state.debug?.device.lcd.pixels.some(Boolean)).toBe(true);
  });

  it("launches one ball and retracts without a second shot", async () => {
    const world = await worldFor("motor-shooter");
    world.advance(500);
    const state = world.snapshot();
    expect(state.status).not.toBe("error");
    expect(state.robots[0]?.status).toBe("completed");
    expect(state.robots[0]!.distance).toBeLessThan(1);
    expect(state.balls[0]!.x).toBeGreaterThan(800);
    expect(
      state.events.filter((event) => event.message.includes("fired loaded-orange")),
    ).toHaveLength(1);
  });

  it("exchanges readiness, measured distance, and acknowledgement between two independent entries", async () => {
    const world = await worldFor("mailbox-cooperation");
    world.advance(600);
    let state = world.snapshot();
    expect(state.status).not.toBe("error");
    expect(state.robots.every((robot) => robot.status === "completed")).toBe(true);
    expect(state.robots.find((robot) => robot.id === "A1")!.distance).toBeLessThan(1);
    expect(state.robots.find((robot) => robot.id === "A2")!.pose.x).toBeCloseTo(575, 0);
    expect(state.debug?.globals.done).toBe("Runner arrived");
    world.select("A2");
    state = world.snapshot();
    expect(state.debug?.globals.distance).toBeCloseTo(325, 1);
  });

  it.each(["vision-search", "mailbox-cooperation"])(
    "exits before moving when synthetic vision is unavailable: %s",
    async (name) => {
      const { prepared } = await prepare(name);
      const runtime = new PreviewRuntime(prepared.programs["src/main.bp"]!.ir, new VirtualDevice());
      runtime.resume();
      const state = runtime.runSlice(500, 0);
      expect(state.status).toBe("completed");
      expect(
        Object.values(state.device.motors).every((motor) => motor.count === 0 && !motor.busy),
      ).toBe(true);
      expect(state.device.events.some((event) => event.detail === "Use 2D simulator")).toBe(true);
    },
  );
});
