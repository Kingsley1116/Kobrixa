import { describe, expect, it } from "vitest";
import { DEFAULT_PIXY2_CONFIG, type Pixy2Config } from "../shared/simulator.js";
import {
  createDefaultScene,
  createPracticeScene,
  createSceneForField,
  PRACTICE_FIELD,
  practiceLineDistance,
  validateScene,
} from "./scene.js";

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

describe("practice field", () => {
  it("round-trips the default practice scene with one Driving Base on the loop", () => {
    const scene = createPracticeScene("src/main.bp");
    expect(validateScene(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
    expect(scene.robots).toHaveLength(1);
    expect(scene.balls).toEqual([]);
    expect(scene.robots[0]!.pose).toEqual(PRACTICE_FIELD.start);
    expect(scene.robots[0]!.controller).toEqual({ kind: "program", entry: "src/main.bp" });
    expect(practiceLineDistance(PRACTICE_FIELD.start.x, PRACTICE_FIELD.start.y)).toBeCloseTo(0);
  });

  it("selects the default scene for each ruleset", () => {
    expect(createSceneForField("practice", "a.bp")).toEqual(createPracticeScene("a.bp"));
    expect(createSceneForField("wro-double-tennis-2026", "a.bp")).toEqual(
      createDefaultScene("a.bp"),
    );
  });

  it("measures distance to straight edges and rounded corners of the loop", () => {
    const { loop } = PRACTICE_FIELD;
    expect(practiceLineDistance(1181, loop.y + loop.height)).toBeCloseTo(0);
    expect(practiceLineDistance(loop.x, 571.5)).toBeCloseTo(0);
    expect(practiceLineDistance(1181, loop.y + 30)).toBeCloseTo(30);
    expect(practiceLineDistance(1181, loop.y - 30)).toBeCloseTo(30);
    // The rectangle's sharp corner lies outside the rounded loop.
    expect(practiceLineDistance(loop.x, loop.y)).toBeCloseTo(Math.SQRT2 * 200 - 200);
    expect(practiceLineDistance(1181, 571.5)).toBeCloseTo(loop.height / 2);
  });

  it.each([
    [
      "two robots",
      (scene: ReturnType<typeof createPracticeScene>) =>
        scene.robots.push({ ...scene.robots[0]!, id: "A2", name: "A2" }),
    ],
    [
      "a built-in opponent",
      (scene: ReturnType<typeof createPracticeScene>) =>
        (scene.robots[0]!.controller = { kind: "builtin" }),
    ],
    [
      "balls",
      (scene: ReturnType<typeof createPracticeScene>) =>
        scene.balls.push({ id: "b", kind: "orange", x: 100, y: 100, z: 20 }),
    ],
  ])("rejects %s", (_name, mutate) => {
    const scene = createPracticeScene();
    mutate(scene);
    expect(() => validateScene(scene)).toThrow(/practice field/);
  });

  it("still loads scenes saved before the practice ruleset existed", () => {
    const legacy = JSON.parse(JSON.stringify(createDefaultScene("main.bp")));
    expect(validateScene(legacy).ruleset).toBe("wro-double-tennis-2026");
  });
});
