import type { IRFunction, IRValue } from "@kobrixa/ir";

/**
 * Prove that a straight-line helper's implicit arrays cannot outlive its call.
 * Explicit Row handles, escaping aliases and control flow retain their existing
 * ownership rules. Only allocations made by the backend are reclaimed.
 */
export function hasCallLocalArrays(fn: IRFunction): boolean {
  if (fn.name === "main" || fn.blocks.length !== 1) return false;
  const block = fn.blocks[0]!;
  if (!["return", "stop"].includes(block.terminator.op)) return false;
  const arrays = new Set(
    fn.locals.filter((local) => local.type.kind === "array").map((local) => local.name),
  );
  const isLocalArray = (value: IRValue) => value.kind === "variable" && arrays.has(value.name);
  const producers = new Set([
    "Sensor.ReadRaw",
    "Sensor.ReadI2CRegisters",
    "Sensor.CommunicateI2C",
    "EV3File.ReadNumberArray",
  ]);
  const borrowedArgument = new Map([
    ["Row.Read", 0],
    ["Row.Write", 0],
    ["Row.Size", 0],
    ["Row.Resize", 0],
    ["Sensor.SendUARTData", 2],
    ["Sensor.CommunicateI2C", 4],
    ["Sensor.WriteI2CRegisters", 4],
    ["EV3File.WriteNumberArray", 2],
  ]);
  for (const instruction of block.instructions) {
    const localTarget = "target" in instruction && arrays.has(instruction.target ?? "");
    switch (instruction.op) {
      case "assign":
        if (localTarget !== isLocalArray(instruction.value)) return false;
        break;
      case "ev3-call":
        if (localTarget && !producers.has(instruction.operation)) return false;
        if (
          instruction.args.some(
            (value, index) =>
              isLocalArray(value) && borrowedArgument.get(instruction.operation) !== index,
          )
        )
          return false;
        break;
      case "call":
        if (localTarget || instruction.args.some(isLocalArray)) return false;
        break;
      case "binary":
        if (localTarget || isLocalArray(instruction.left) || isLocalArray(instruction.right))
          return false;
        break;
      case "unary":
        if (localTarget || isLocalArray(instruction.value)) return false;
        break;
    }
  }
  return !(
    block.terminator.op === "return" &&
    block.terminator.value &&
    isLocalArray(block.terminator.value)
  );
}
