import { describe, expect, it } from "vitest";
import { DEFAULT_PIXY2_CONFIG, type Pixy2Config } from "../shared/simulator.js";
import { createDefaultScene, validateScene } from "./scene.js";

function cameraScene() {
  const scene = createDefaultScene("main.bp");
  scene.robots[0]!.sensors = [
    { port: 4, kind: "pixy2", x: 75, y: 0, angle: 0, range: 2500, fov: 60 },
  ];
  return scene;
}

describe("wheel traction and gyro direction settings", () => {
  it("keeps both settings optional when restoring older scenes", () => {
    const scene = createDefaultScene("main.bp");
    const restored = validateScene(JSON.parse(JSON.stringify(scene)));
    expect(restored).toEqual(scene);
    expect(restored.robots[0]!.wheelTraction).toBeUndefined();
    expect(
      restored.robots[0]!.sensors.find((sensor) => sensor.kind === "gyro")!.inverted,
    ).toBeUndefined();
  });

  it.each(["slip", "grip"] as const)("round-trips %s wheels and gyro reversal", (wheelTraction) => {
    const scene = createDefaultScene("main.bp");
    const robot = scene.robots[0]!;
    robot.wheelTraction = wheelTraction;
    robot.sensors.find((sensor) => sensor.kind === "gyro")!.inverted = true;
    expect(validateScene(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
  });

  it("rejects unsupported wheel traction and non-boolean sensor reversal", () => {
    const scene = createDefaultScene("main.bp");
    Object.assign(scene.robots[0]!, { wheelTraction: "sticky" });
    expect(() => validateScene(scene)).toThrow(/wheelTraction/);
    scene.robots[0]!.wheelTraction = "grip";
    Object.assign(scene.robots[0]!.sensors[2]!, { inverted: "true" });
    expect(() => validateScene(scene)).toThrow(/inverted/);
  });
});

describe("Pixy2 scene settings", () => {
  it("preserves existing scenes and permits omitted camera defaults without rewriting files", () => {
    const existing = createDefaultScene("main.bp");
    expect(validateScene(existing)).toEqual(existing);
    const scene = cameraScene();
    const restored = validateScene(JSON.parse(JSON.stringify(scene)));
    expect(restored).toEqual(scene);
    expect(restored.robots[0]!.sensors[0]!.pixy2).toBeUndefined();
  });

  it("round-trips camera geometry and trained or untrained signatures", () => {
    const scene = cameraScene();
    scene.robots[0]!.sensors[0]!.pixy2 = {
      height: 500,
      pitch: -89,
      verticalFov: 170,
      orangeSignature: 7,
      purpleSignature: 0,
    };
    expect(validateScene(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
  });

  it.each([
    ["height", -1],
    ["height", 501],
    ["pitch", -90],
    ["pitch", 90],
    ["verticalFov", 0],
    ["verticalFov", 171],
    ["orangeSignature", -1],
    ["orangeSignature", 8],
    ["purpleSignature", 1.5],
    ["height", Infinity],
  ] satisfies Array<[keyof Pixy2Config, number]>)("rejects invalid %s = %s", (key, value) => {
    const scene = cameraScene();
    scene.robots[0]!.sensors[0]!.pixy2 = { ...DEFAULT_PIXY2_CONFIG, [key]: value };
    expect(() => validateScene(scene)).toThrow(key);
  });

  it.each([0, 171, 360])("rejects a camera horizontal field of view of %s", (fov) => {
    const scene = cameraScene();
    scene.robots[0]!.sensors[0]!.fov = fov;
    expect(() => validateScene(scene)).toThrow(/field of view/);
  });

  it("requires complete explicitly supplied camera settings and rejects misspelled properties", () => {
    const scene = cameraScene();
    const sensor = scene.robots[0]!.sensors[0]!;
    Object.assign(sensor, { pixy2: { height: 100 } });
    expect(() => validateScene(scene)).toThrow(/pitch/);
    Object.assign(sensor, { pixy2: { ...DEFAULT_PIXY2_CONFIG, cameraPitch: 0 } });
    expect(() => validateScene(scene)).toThrow(/cameraPitch/);
  });
});
