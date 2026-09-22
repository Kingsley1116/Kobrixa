// Execute real movement objects, including high correction gains and repeated calls.
import { VM } from "./ev3-vm.mjs";

export function checkMovement(decoded, names, setGlobal) {
  const power = (value) => Math.trunc(Math.max(-100, Math.min(100, value)));
  const powers = (run) => run.trace.filter((t) => t.op === "OUTPUT_POWER").map((t) => t.args[2]);
  const failures = [];
  let checks = 0;
  function check(name, actual, expected, input) {
    checks++;
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      failures.push({ name, input, actual, expected });
  }
  function start(name, inputs, globals = {}, options = {}) {
    const vm = new VM(decoded, { maxSteps: 20000, ...options });
    vm.frames.pop();
    vm.activeObjects.clear();
    const frame = vm.start(names.indexOf(name));
    inputs.forEach((value, index) => frame.l.writeFloatLE(value, index * 4));
    for (const [name, value] of Object.entries(globals)) setGlobal(vm, name, value);
    return vm;
  }
  const grid = {
    gains: [1, 1.5, 2, 3, 5, 6],
    drivePowers: [-100, -60, -50, -30, 25, 40, 45, 50, 60, 100],
    targetAngles: [-105, -5, 0, 5, 10, 27, 45],
    headings: [-180, -150, -90, -45, -20, -10, 0, 10, 20, 45, 90, 150, 180],
  };
  let gridCases = 0;
  for (const p of grid.gains)
    for (const drive of grid.drivePowers)
      for (const angle of grid.targetAngles)
        for (const heading of grid.headings) {
          const vm = start("move_gyro", [p, drive, angle], { rpx: heading });
          const run = vm.run();
          const input = { p, drive, angle, heading };
          check("move_gyro terminates", run.status, "ended", input);
          check(
            "move_gyro signed powers",
            powers(run),
            [power(-(drive + (heading + angle) * p)), power(drive - (heading + angle) * p)],
            input,
          );
          gridCases++;
        }
  // Reuse the same native object memory while headings and drive direction
  // change; this checks output stability beyond an isolated first invocation.
  const sequenceVm = start("move_gyro", [3, 100, 0], { rpx: 0 });
  const sequence = [
    [3, 100, 0, 0],
    [3, 100, 0, 20],
    [3, 100, 0, -20],
    [2, -100, 10, 45],
    [1.5, -60, 0, -90],
    [5, 100, -105, 0],
    [1, 45, -5, 5],
    [2, 60, 45, 0],
    [3, 100, 0, 0],
  ];
  for (const [index, [p, drive, angle, heading]] of sequence.entries()) {
    if (index > 0) sequenceVm.start(names.indexOf("move_gyro"));
    sequenceVm.f().l.writeFloatLE(p, 0);
    sequenceVm.f().l.writeFloatLE(drive, 4);
    sequenceVm.f().l.writeFloatLE(angle, 8);
    setGlobal(sequenceVm, "rpx", heading);
    sequenceVm.trace = [];
    const run = sequenceVm.run();
    check("reused movement object " + index, powers(run), [
      power(-(drive + (heading + angle) * p)),
      power(drive - (heading + angle) * p),
    ]);
  }
  const turnCases = [
    { angle: 322, gain: 50, headings: [0, 10, 20, 30, 36], expected: [-45, -45, -45, -45] },
    { angle: 23, gain: 5, headings: [0, 350, 340], expected: [45, 15] },
  ];
  for (const scenario of turnCases) {
    const vm = start("turn_gyro", [scenario.angle, scenario.gain], { is_stuck: "False" });
    let sample = 0;
    const execute = vm.execute.bind(vm);
    vm.execute = (instruction) => {
      // Deterministic time and gyro trajectory, not a physics model.
      vm.time += 0.05;
      if (
        instruction.name === "CALL" &&
        instruction.args[0].n === names.indexOf("turn_gyro_rpx") + 1
      )
        setGlobal(
          vm,
          "rpx_360",
          scenario.headings[Math.min(sample++, scenario.headings.length - 1)],
        );
      execute(instruction);
    };
    const run = vm.run();
    check("turn terminates at heading " + scenario.angle, run.status, "ended");
    check("turn power sequence " + scenario.angle, powers(run), scenario.expected);
  }
  const timedCases = [
    [50, 50, 200],
    [-50, -40, 150],
    [25, 25, 75],
    [100, 100, 500],
  ];
  for (const inputs of timedCases) {
    const vm = start("move_time", inputs);
    const execute = vm.execute.bind(vm);
    vm.execute = (instruction) => {
      vm.time += 0.05;
      execute(instruction);
    };
    const run = vm.run();
    const commands = powers(run);
    check("move_time terminates " + inputs, run.status, "ended");
    check(
      "move_time maintains wheel directions " + inputs,
      commands.length > 0 &&
        commands.every((value, index) => value === power(index % 2 === 0 ? -inputs[0] : inputs[1])),
      true,
    );
  }
  return {
    grid,
    gridCases,
    repeatedCalls: sequence.length,
    turns: turnCases.length,
    timedMoves: timedCases.length,
    checks,
    failures,
  };
}
