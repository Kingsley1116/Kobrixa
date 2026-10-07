import { readFile } from "node:fs/promises";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { describe, expect, it } from "vitest";
import { DEFAULT_PIXY2_CONFIG, type SimulationScene } from "../shared/simulator.js";
import { createDefaultScene } from "./scene.js";
import { SimulationWorld } from "./world.js";

function cameraScene(): SimulationScene {
  const scene = createDefaultScene("main.bp");
  scene.robots = [scene.robots[0]!];
  scene.robots[0]!.pose = { x: 300, y: 300, heading: 0 };
  scene.robots[0]!.sensors = [
    { port: 1, kind: "pixy2", x: 75, y: 0, angle: 0, range: 2500, fov: 60 },
  ];
  scene.balls = [{ id: "orange", kind: "orange", x: 750, y: 300, z: 20 }];
  return scene;
}

async function simulation(source: string, scene = cameraScene()) {
  const front = await new BasicPlusFrontend().compile(
    {
      root: "/simulation",
      manifest: {
        schemaVersion: 1,
        name: "Pixy2",
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
  expect(front.diagnostics).toEqual([]);
  return new SimulationWorld(scene, { programs: { "main.bp": { ir: front.ir!, files: {} } } });
}

const read = "blocks = Sensor.ReadI2CRegisters(1, 1, 81, 5)\n";

describe("Pixy2 programs in the shared physical world", () => {
  it("runs the existing hardware probe unchanged with configurable taught signatures", async () => {
    const source = await readFile(
      new URL("../../../../tests/hardware/fixtures/pixy2-signature.bp", import.meta.url),
      "utf8",
    );
    const scene = cameraScene();
    scene.robots[0]!.sensors[0]!.pixy2 = {
      ...DEFAULT_PIXY2_CONFIG,
      orangeSignature: 2,
      purpleSignature: 7,
    };
    scene.balls.push({ id: "second", kind: "orange", x: 750, y: 400, z: 20 });
    const world = await simulation(source, scene);
    world.run();
    world.advance(1);
    let state = world.snapshot();
    expect(state.status).toBe("running");
    expect(state.debug?.device.events.some((event) => event.detail === "Count: 2")).toBe(true);
    expect(state.debug?.device.lcd.pixels.some(Boolean)).toBe(true);
    world.buttons("A1", ["enter"]);
    world.buttons("A1", []);
    world.advance(20);
    state = world.snapshot();
    expect(state.robots[0]!.status).toBe("completed");
    expect(state.robots[0]!.distance).toBe(0);
  });

  it("updates the bounding box as motors move the camera closer to a ball", async () => {
    const world = await simulation(
      'Motor.Start("BC", 25)\nWhile 1\n' + read + "Program.Delay(10)\nEndWhile\n",
    );
    world.run();
    world.advance(1);
    const first = world.snapshot().debug!.globals.blocks as number[];
    world.advance(80);
    const state = world.snapshot();
    const later = state.debug!.globals.blocks as number[];
    expect(state.status).toBe("running");
    expect(first[0]).toBe(1);
    expect(later[0]).toBe(1);
    expect(later[3]).toBeGreaterThan(first[3]!);
    expect(state.robots[0]!.distance).toBeGreaterThan(40);
  });

  it("occludes a target behind an active robot but not a disabled robot", async () => {
    for (const enabled of [true, false]) {
      const scene = cameraScene();
      const blocker = structuredClone(scene.robots[0]!);
      blocker.id = blocker.name = "A2";
      blocker.pose.x = 550;
      blocker.controller = enabled ? { kind: "program", entry: "main.bp" } : { kind: "disabled" };
      scene.robots.push(blocker);
      const world = await simulation(read, scene);
      world.run();
      world.advance(1);
      expect((world.snapshot().debug!.globals.blocks as number[])[0]).toBe(enabled ? 0 : 1);
    }
  });

  it("uses height along the sight line to see above the central barrier", async () => {
    for (const height of [40, 400]) {
      const scene = cameraScene();
      scene.robots[0]!.pose = { x: 600, y: 300, heading: 90 };
      scene.robots[0]!.sensors[0]!.pixy2 = {
        ...DEFAULT_PIXY2_CONFIG,
        height,
        pitch: -30,
        verticalFov: 100,
      };
      scene.balls = [{ id: "opponent-ball", kind: "orange", x: 600, y: 750, z: 20 }];
      const world = await simulation(read, scene);
      world.run();
      world.advance(1);
      expect((world.snapshot().debug!.globals.blocks as number[])[0]).toBe(height === 40 ? 0 : 1);
    }
  });

  it("pauses and locates unsupported camera operations instead of returning fake readings", async () => {
    const world = await simulation("rgb = Sensor.ReadI2CRegisters(1, 1, 94, 3)\n");
    world.run();
    world.advance(1);
    const state = world.snapshot();
    expect(state.status).toBe("error");
    expect(state.events.at(-1)).toMatchObject({
      kind: "error",
      robotId: "A1",
      span: { file: "main.bp", start: { line: 1 } },
    });
  });

  it("replays identical camera and motion results regardless of snapshot frequency", async () => {
    const source = 'Motor.Start("BC", 20)\nWhile 1\n' + read + "Program.Delay(10)\nEndWhile\n";
    const a = await simulation(source),
      b = await simulation(source);
    a.run();
    b.run();
    for (let i = 0; i < 100; i++) {
      a.advance(1);
      a.snapshot();
    }
    b.advance(100);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
});
