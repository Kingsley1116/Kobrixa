import { describe, expect, it } from "vitest";
import { createDefaultScene, createPracticeScene, validateScene } from "./scene.js";
import { applyRobotPreset, detectRobotPreset, robotHardware } from "./robot-presets.js";

describe("robot presets", () => {
  it("recognizes the default robots of both fields", () => {
    expect(detectRobotPreset(createPracticeScene().robots[0]!)).toBe("driving-base");
    expect(detectRobotPreset(createDefaultScene().robots[0]!)).toBe("wro");
  });

  it("matches the LEGO Education Driving Base ports", () => {
    const hardware = robotHardware("driving-base");
    expect(hardware.wheels.map((wheel) => wheel.port)).toEqual(["B", "C"]);
    expect(hardware.sensors.map((sensor) => [sensor.port, sensor.kind])).toEqual([
      [1, "touch"],
      [2, "gyro"],
      [3, "color"],
      [4, "ultrasonic"],
    ]);
    expect(hardware.shooter).toBeNull();
  });

  it("keeps identity, controller and pose when applying a preset", () => {
    const robot = { ...createDefaultScene("x.bp").robots[0]!, wheelTraction: "grip" as const };
    const next = applyRobotPreset(robot, "driving-base");
    expect(next).toMatchObject({
      id: robot.id,
      name: robot.name,
      team: robot.team,
      controller: robot.controller,
      pose: robot.pose,
    });
    expect(next.wheelTraction).toBeUndefined();
    expect(detectRobotPreset(next)).toBe("driving-base");
    const scene = createDefaultScene("x.bp");
    scene.robots[0] = next;
    expect(() => validateScene(scene)).not.toThrow();
  });

  it("reads any hardware edit as custom, and treats omitted defaults as unchanged", () => {
    const robot = createPracticeScene().robots[0]!;
    expect(detectRobotPreset({ ...robot, wheelTraction: "slip" })).toBe("driving-base");
    expect(detectRobotPreset({ ...robot, mass: 1 })).toBe("custom");
    expect(detectRobotPreset({ ...robot, sensors: [...robot.sensors].reverse() })).toBe(
      "driving-base",
    );
    expect(detectRobotPreset({ ...robot, sensors: robot.sensors.slice(1) })).toBe("custom");
    // Round-tripping through the schema keeps the preset identity.
    const restored = validateScene(JSON.parse(JSON.stringify(createPracticeScene())));
    expect(detectRobotPreset(restored.robots[0]!)).toBe("driving-base");
  });
});
