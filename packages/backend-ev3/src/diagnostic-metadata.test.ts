import { describe, expect, it } from "vitest";
import { getDiagnosticHelp } from "@kobrixa/compiler/diagnostic-help";
import type { IRFunction, IRInstruction, KobrixaIR } from "@kobrixa/ir";
import { EV3Backend } from "./backend.js";

function fn(name: string, instructions: IRInstruction[] = []): IRFunction {
  return {
    name,
    parameters: [],
    returnType: { kind: "void" },
    locals: [],
    entryBlock: "entry",
    blocks: [{ id: "entry", instructions, terminator: { op: "return" } }],
  };
}
function program(instructions: IRInstruction[] = [], functions: IRFunction[] = []): KobrixaIR {
  return {
    version: 1,
    program: { name: "metadata", entryFunction: "main" },
    globals: [],
    functions: [fn("main", instructions), ...functions],
    resources: [],
    sourceFiles: ["main.bp"],
  };
}

const inputFunction: IRFunction = {
  ...fn("read"),
  parameters: [{ name: "value", type: { kind: "number" }, scope: "parameter" }],
};
const outputFunction: IRFunction = {
  ...fn("read"),
  parameters: [{ name: "value", type: { kind: "number" }, scope: "parameter", direction: "out" }],
};
const valueFunction: IRFunction = {
  ...fn("read"),
  returnType: { kind: "number" },
  blocks: [
    {
      id: "entry",
      instructions: [],
      terminator: { op: "return", value: { kind: "number", value: 1 } },
    },
  ],
};

describe("producer-selected EV3 diagnostic help", () => {
  const cases: Array<{
    ir: KobrixaIR;
    code: string;
    helpKey: string;
    message: string;
    retained?: string[];
  }> = [
    {
      ir: program([{ op: "call", functionName: "missing", args: [] }]),
      code: "EV32003",
      helpKey: "unknown-function",
      message: "Unknown user function 'missing'.",
    },
    {
      ir: program([{ op: "call", functionName: "read", args: [] }], [inputFunction]),
      code: "EV32003",
      helpKey: "missing-argument",
      message: "Missing argument for user function 'read'.",
    },
    {
      ir: program(
        [{ op: "call", functionName: "read", args: [{ kind: "number", value: 1 }] }],
        [outputFunction],
      ),
      code: "EV32003",
      helpKey: "out-variable",
      message: "Output argument 'value' must be a variable.",
    },
    {
      ir: program([{ op: "call", functionName: "read", args: [] }], [valueFunction]),
      code: "EV32003",
      helpKey: "missing-return-target",
      message: "Function 'read' requires a return target.",
    },
    {
      ir: program(),
      retained: ["missing"],
      code: "EV32003",
      helpKey: "unknown-retained-function",
      message: "Unknown retained function 'missing'.",
    },
    {
      ir: { ...program(), program: { name: "metadata", entryFunction: "missing" } },
      code: "EV32003",
      helpKey: "unknown-entry-function",
      message: "Unknown entry function 'missing'.",
    },
    {
      ir: program([{ op: "ev3-call", operation: "MotorA.Unknown", args: [] }]),
      code: "EV32010",
      helpKey: "legacy-motor-call",
      message: "Unsupported legacy motor call 'MotorA.Unknown'.",
    },
    {
      ir: program([{ op: "ev3-call", operation: "Unimplemented.Operation", args: [] }]),
      code: "EV32010",
      helpKey: "operation-not-lowered",
      message: "EV3 operation 'Unimplemented.Operation' is catalogued but not lowered yet.",
    },
  ];
  it.each(cases)(
    "preserves $code while selecting $helpKey",
    async ({ ir, code, helpKey, message, retained }) => {
      const result = await new EV3Backend(retained ? { retainFunctions: retained } : {}).compile(
        ir,
        new AbortController().signal,
      );
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code, helpKey, message, severity: "error" }),
      ]);
      expect(getDiagnosticHelp(code, helpKey)?.helpKey).toBe(helpKey);
      expect(result.rbf).toBeUndefined();
    },
  );
});
