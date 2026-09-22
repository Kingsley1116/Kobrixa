import assert from "node:assert/strict";
import { test } from "node:test";
import { VM } from "./support/ev3-vm.mjs";
import { compileRobotFixture } from "./support/robot-project.mjs";

test("Robot-control bytecode", async (t) => {
  const { decoded, names, global } = await compileRobotFixture();
  const checks = [];
  function check(name, actual, expected) {
    checks.push({ name, actual, expected });
  }

  for (const [name, scenario] of Object.entries({
    ready: { sensor: 0, button: 0 },
    gyroFailure: { sensor: 1, button: 0 },
    left: { sensor: 0, button: 5 },
    down: { sensor: 0, button: 3 },
    right: { sensor: 0, button: 4 },
    enter: { sensor: 0, button: 2 },
  })) {
    const vm = new VM(decoded, {
      ...scenario,
      maxSteps: 100000,
      maxTrace: name === "enter" ? 10000 : 250,
    });
    const run = vm.run();
    check(name + ": no interpreter error", run.status === "bounded", true);
    const texts = run.trace.filter((t) => t.op === "UI_DRAW.TEXT").map((t) => t.args[3]);
    const powers = run.trace.filter((t) => t.op === "OUTPUT_POWER").map((t) => t.args);
    if (name === "ready") {
      check("READY screen", texts.includes("READY"), true);
      check("initial X", global(vm, "x"), 700);
      check("initial Y", global(vm, "y"), 0);
      check("field bounds", [global(vm, "b_x_upper"), global(vm, "b_y_upper")], [1140, 2800]);
      const matrix = vm.arrays.get(Math.round(global(vm, "config")));
      const values = Array.from({ length: 42 }, (_, i) => matrix.b.readFloatLE(i * 4));
      check(
        "Matrix dimensions and all five configuration rows",
        values.slice(0, 22),
        [10, 4, 1, 0, 1, 1, 1, 0, 1, 1, 100, 0, 100, 5, 100, 0, 100, 5, 0, 0, 1, 1],
      );
      check("gyro reset UART bytes", run.trace.find((t) => t.op === "INPUT_WRITE")?.bytes, [17]);
    }
    if (name === "gyroFailure")
      check("gyro reset failure branch", texts.includes("GYRO FAIL"), true);
    if (name === "left")
      check("left button motor D", powers.slice(0, 2), [
        [0, 8, 100],
        [0, 8, -100],
      ]);
    if (name === "down")
      check(
        "down button numeric display",
        run.trace.some((t) => t.op === "UI_DRAW.VALUE"),
        true,
      );
    if (name === "right")
      check(
        "right button sound",
        run.trace.some((t) => t.op === "SOUND.PLAY" && t.args[1].endsWith("chime")),
        true,
      );
    if (name === "enter") {
      check("enter starts gyro/display/odometry threads", run.scheduler.threadsStarted, 3);
      check(
        "camera sampled ten times",
        run.trace.filter((t) => t.op === "INPUT_DEVICE.SETUP").length,
        10,
      );
      check("initial drive motor commands", powers.slice(0, 4), [
        [0, 8, -100],
        [0, 1, 100],
        [0, 2, -60],
        [0, 4, 60],
      ]);
    }
  }
  function invoke(name, setup, scenario = {}) {
    const vm = new VM(decoded, { sensor: 0, maxSteps: 5000, ...scenario });
    vm.frames.pop();
    vm.activeObjects.clear();
    const frame = vm.start(names.indexOf(name));
    setup(vm, frame.l);
    const run = vm.run();
    check(name + ": object execution", run.status, "ended");
    return { vm, frame, run };
  }
  for (const raw of [-450, -45, 0, 90, 181, 359, 450]) {
    const { frame } = invoke("getheading", (vm, local) => local.writeFloatLE(2, 0), {
      sensor: raw,
    });
    const angle = ((raw % 360) + 360) % 360;
    check("gyro 360 at raw " + raw, frame.l.readFloatLE(12), angle);
    check("gyro signed at raw " + raw, frame.l.readFloatLE(8), angle <= 180 ? -angle : 360 - angle);
  }
  for (const [y, expected] of [
    [2200, 45],
    [2100, 100],
    [2000, 100],
  ]) {
    const { frame } = invoke("speed", (vm, local) => {
      local.write("True\0");
      local.writeFloatLE(2100, 252);
      global(vm, "y", y);
    });
    check("speed output at Y=" + y, frame.l.readFloatLE(256), expected);
  }
  const drive = invoke("move_gyro", (vm, local) => {
    local.writeFloatLE(2, 0);
    local.writeFloatLE(60, 4);
    local.writeFloatLE(5, 8);
    global(vm, "rpx", 10);
  });
  check(
    "gyro steering arithmetic",
    drive.run.trace.filter((t) => t.op === "OUTPUT_POWER").map((t) => t.args),
    [
      [0, 2, -90],
      [0, 4, 30],
    ],
  );
  const pixy = invoke(
    "getsignature",
    (vm, local) => {
      local.writeFloatLE(1, 0);
      local.writeFloatLE(2, 4);
    },
    { i2cReplies: [[1, 200, 180, 20, 30]] },
  );
  check(
    "Pixy unsigned coordinates",
    [8, 12, 16, 20].map((i) => pixy.frame.l.readFloatLE(i)),
    [200, 180, 20, 30],
  );
  for (const [y, x] of [
    [1000, -50],
    [850, 130],
    [550, -250],
    [1000, 0],
  ]) {
    const { frame } = invoke("atan2_m90", (vm, local) => {
      local.writeFloatLE(y, 0);
      local.writeFloatLE(x, 4);
    });
    check(`atan2_m90(${y},${x})`, frame.l.readFloatLE(8), (Math.atan2(y, x) * 180) / Math.PI - 90);
  }
  // Isolate one real odometry iteration. Device counts are -50/+50 and virtual
  // time is already beyond the ten-ms sample gate; no physical movement is modeled.
  for (const angle of [0, 90, -90]) {
    const vm = new VM(decoded, { maxSteps: 1000, motorCounts: [-50, 50] });
    vm.frames.pop();
    vm.activeObjects.clear();
    vm.start(names.indexOf("sub_is_stuck"));
    global(vm, "x", 700);
    global(vm, "y", 500);
    global(vm, "b_x_upper", 1140);
    global(vm, "b_y_upper", 2800);
    global(vm, "rpx", angle);
    const baseExecute = vm.execute.bind(vm);
    vm.execute = (instruction) => {
      if (instruction.name === "TIMER_WAIT") {
        vm.finished = true;
        return;
      }
      baseExecute(instruction);
    };
    const run = vm.run();
    check("odometry status at " + angle, run.status, "ended");
    check("odometry X at " + angle, global(vm, "x"), 700 + 100 * Math.sin((angle * Math.PI) / 180));
    check("odometry Y at " + angle, global(vm, "y"), 500 + 100 * Math.cos((angle * Math.PI) / 180));
  }

  for (const { name, actual, expected } of checks) {
    await t.test(name, () => {
      if (typeof expected === "number" && typeof actual === "number")
        assert(Math.abs(actual - expected) < 0.001, `${actual} != ${expected}`);
      else assert.deepEqual(actual, expected);
    });
  }
});
