import { describe, expect, it } from "vitest";
import type { SourceProject } from "@kobrixa/compiler";
import { validateIR } from "@kobrixa/ir";
import {
  BASIC_PLUS_API_COMPLETIONS,
  BASIC_PLUS_KEYWORDS,
  BasicPlusFrontend,
  formatBasicPlus,
  parse,
} from "./index.js";

function project(content: string): SourceProject {
  return {
    root: "/project",
    manifest: {
      schemaVersion: 1,
      name: "demo",
      language: "bp",
      entry: "main.bp",
      target: "ev3-native",
      assets: [],
      outputDir: "build",
    },
    sources: [{ path: "main.bp", content }],
    assets: [],
  };
}

describe("BasicPlusFrontend", () => {
  it("lowers case-insensitive control flow and EV3 calls", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(
        'Count = 0\nWHILE Count < 2\n  LCD.Text(1, 0, 0, 1, "Hi")\n  Count = Count + 1\nEndWhile\n',
      ),
      new AbortController().signal,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.functions[0]?.blocks.length).toBeGreaterThan(1);
  });

  it("reports unsupported calls", async () => {
    const result = await new BasicPlusFrontend().compile(
      project("Unknown.Do()\n"),
      new AbortController().signal,
    );
    expect(result.diagnostics[0]?.code).toBe("BP3001");
  });

  it("accepts bare and quoted Boolean values without turning display text into a Boolean", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(
        'If "TrUe" Then\n  LCD.Text(1, 0, 0, 1, "True")\nEndIf\nWhile "False"\n  LCD.Clear()\nEndWhile\nMotor.Stop("A", true)\nMotor.Stop("A", "FaLsE")\n',
      ),
      new AbortController().signal,
    );

    expect(result.diagnostics).toEqual([]);
    expect(validateIR(result.ir!)).toEqual([]);
    const blocks = result.ir!.functions[0]!.blocks;
    const branches = blocks.map((block) => block.terminator).filter((item) => item.op === "branch");
    expect(branches.map((branch) => branch.condition)).toEqual(
      expect.arrayContaining([
        { kind: "boolean", value: true },
        { kind: "boolean", value: false },
      ]),
    );
    const calls = blocks
      .flatMap((block) => block.instructions)
      .filter((instruction) => instruction.op === "ev3-call");
    expect(calls.find((call) => call.operation === "LCD.Text")?.args[4]).toEqual({
      kind: "string",
      value: "True",
    });
    expect(
      calls.filter((call) => call.operation === "Motor.Stop").map((call) => call.args[1]),
    ).toEqual([
      { kind: "boolean", value: true },
      { kind: "boolean", value: false },
    ]);
  });

  it("formats blocks", () =>
    expect(formatBasicPlus("If True Then\nLCD.Clear()\nEndIf\n")).toContain("  LCD.Clear()"));

  it("describes keyword and EV3 API completions", () => {
    expect(BASIC_PLUS_KEYWORDS).toEqual(
      expect.arrayContaining([
        "Include",
        "Import",
        "Folder",
        "For",
        "EndFor",
        "To",
        "Step",
        "If",
        "Then",
        "Else",
        "ElseIf",
        "EndIf",
        "Goto",
        "Function",
        "EndFunction",
        "Private",
        "Sub",
        "EndSub",
        "While",
        "EndWhile",
        "And",
        "Or",
        "In",
        "Out",
        "Number",
        "String",
        "Break",
        "Continue",
        "Return",
      ]),
    );
    expect(BASIC_PLUS_API_COMPLETIONS.find((item) => item.label === "Motor.Start")).toMatchObject({
      signature: "Motor.Start(string, integer)",
      insertText: 'Motor.Start("${1}", ${2:0})',
      category: "motor",
    });
    expect(
      BASIC_PLUS_API_COMPLETIONS.find((item) => item.label === "Button.IsPressed"),
    ).toMatchObject({
      signature: "Button.IsPressed(string): boolean",
    });
  });

  it("parses the complete Clev3r keyword parameter syntax", () => {
    const result = parse(
      "main.bp",
      "Function Transform(in number value, out string text, in number[] samples)\nReturn\nEndFunction\n",
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.parsed.functions[0]?.parameters).toMatchObject([
      { name: "value", direction: "in", type: { kind: "number" } },
      { name: "text", direction: "out", type: { kind: "string" } },
      { name: "samples", direction: "in", type: { kind: "array", element: "number" } },
    ]);
  });

  it("loads Clev3r imports and accepts folder and private directives", async () => {
    const input = project('folder "prjs" "Demo"\nimport "lib"\nHelper("ok")\n');
    input.sources.push({
      path: "lib.bpm",
      content: "Private\nFunction Helper(in string message)\nReturn\nEndFunction\n",
    });
    const result = await new BasicPlusFrontend().compile(input, new AbortController().signal);

    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.program.runtimeDirectory).toBe("/home/root/lms2012/prjs/Demo");
    expect(result.ir?.sourceFiles).toEqual(["lib.bpm", "main.bp"]);
    expect(result.ir?.functions.map((fn) => fn.name)).toContain("helper");
  });

  it("preserves SD Folder deployment and rejects ambiguous or escaping paths", async () => {
    const valid = await new BasicPlusFrontend().compile(
      project('Folder "sd" "Lesson"\nLCD.Clear()'),
      new AbortController().signal,
    );
    expect(valid.ir?.program.runtimeDirectory).toBe("/home/root/lms2012/prjs/SD_Card/Lesson");
    for (const source of [
      'Folder "usb" "Lesson"',
      'Folder "sd" "../Lesson"',
      'Folder "sd" "Lesson"\nFolder "prjs" "Other"',
    ]) {
      const result = await new BasicPlusFrontend().compile(
        project(source),
        new AbortController().signal,
      );
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.some((item) => item.code === "BP1051")).toBe(true);
    }
  });

  it("lowers break, continue, increment, and compound assignments", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(
        "value = 0\nWhile value < 10\nvalue++\nIf value = 2 Then\nContinue\nEndIf\nIf value = 4 Then\nBreak\nEndIf\nvalue += 2\nEndWhile\nFor i = 3 To 1 Step -1\nContinue\nEndFor\n",
      ),
      new AbortController().signal,
    );

    expect(result.diagnostics).toEqual([]);
    expect(validateIR(result.ir!)).toEqual([]);
    const instructions = result.ir!.functions[0]!.blocks.flatMap((block) => block.instructions);
    expect(
      instructions.filter(
        (instruction) => instruction.op === "binary" && instruction.operator === "+",
      ),
    ).toHaveLength(3);
    expect(
      instructions.find(
        (instruction) => instruction.op === "binary" && instruction.operator === ">=",
      ),
    ).toBeDefined();
    const jumpTargets = result
      .ir!.functions[0]!.blocks.map((block) => block.terminator)
      .filter((terminator) => terminator.op === "jump")
      .map((terminator) => terminator.target);
    expect(jumpTargets.some((target) => target.startsWith("while_end_"))).toBe(true);
    expect(jumpTargets.some((target) => target.startsWith("for_update_"))).toBe(true);
  });

  it("shares explicit Clev3r globals with imported subroutines", async () => {
    const input = project('angle = 0\nimport "gyro"\nUpdateAngle()\n');
    input.sources.push({
      path: "gyro.bpm",
      content: "Sub UpdateAngle()\n  @angle += Sensor1.Raw1()\nEndSub\n",
    });
    const result = await new BasicPlusFrontend().compile(input, new AbortController().signal);

    expect(result.diagnostics).toEqual([]);
    expect(validateIR(result.ir!)).toEqual([]);
    expect(result.ir!.globals).toMatchObject([
      { name: "angle", type: { kind: "integer" }, scope: "global" },
    ]);
    expect(result.ir!.functions.find((fn) => fn.name === "updateangle")?.locals).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "angle" })]),
    );
  });

  it("lowers Clev3r string arrays with string element reads and writes", async () => {
    const result = await new BasicPlusFrontend().compile(
      project('string[] names\nnames[0] = "Alpha"\nname = names[0]\n'),
      new AbortController().signal,
    );

    expect(result.diagnostics).toEqual([]);
    expect(validateIR(result.ir!)).toEqual([]);
    expect(result.ir!.globals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "names", type: { kind: "array", element: "string" } }),
        expect.objectContaining({ name: "name", type: { kind: "string" } }),
      ]),
    );
  });

  it("infers a string Function return so callers receive text rather than a numeric bit pattern", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(
        'message = Greeting("Kobrixa")\nFunction Greeting(in string name)\nReturn "Hi " + name\nEndFunction\n',
      ),
      new AbortController().signal,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.functions.find((fn) => fn.name === "greeting")?.returnType).toEqual({
      kind: "string",
    });
    expect(result.ir?.globals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "message", type: { kind: "string" } }),
      ]),
    );
  });

  it("accepts Clev3r byte-array UART data and Boolean values in numeric storage", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(
        "number[] resetData\nresetData[0] = 17\nSensor.SendUARTData(1, 1, resetData)\nnumber valid\nvalid = 1 < 2\n",
      ),
      new AbortController().signal,
    );

    expect(result.diagnostics).toEqual([]);
    expect(validateIR(result.ir!)).toEqual([]);
  });

  it("lowers Thread.Run and region directives used by Clev3r modules", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(
        "Region Gyro\nThread.Run = Update\nEndRegion\nSub Update()\nThread.Yield()\nEndSub\n",
      ),
      new AbortController().signal,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.functions[0]?.blocks[0]?.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "thread-start", functionName: "update" }),
      ]),
    );
  });

  it("rejects break and continue outside loops", async () => {
    const result = await new BasicPlusFrontend().compile(
      project("Break\nContinue\n"),
      new AbortController().signal,
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["BP2006", "BP2007"]);
  });
});

describe("numeric variable storage", () => {
  it("accepts numeric outputs into integer-initialized globals across Subs", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(`value = 0
Sub Worker
  ReadValue(value)
EndSub
Function ReadValue(out number output)
  output = 1.5
EndFunction
`),
      new AbortController().signal,
    );
    expect(result.diagnostics).toEqual([]);
    expect(validateIR(result.ir!)).toEqual([]);
    expect(result.ir!.globals.find((variable) => variable.name === "value")!.type.kind).toBe(
      "number",
    );
  });

  it("continues to reject string storage for numeric outputs", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(`value = "text"
ReadValue(value)
Function ReadValue(out number output)
  output = 1.5
EndFunction
`),
      new AbortController().signal,
    );
    expect(result.diagnostics.map((entry) => entry.code)).toContain("BP2006");
  });

  it("widens all numeric return branches to one floating-point call signature", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(`
answer = Clamp(42.5)
Function Clamp(in number value)
  If value < 0 Then
    Return 0
  ElseIf value > 100 Then
    Return 100
  EndIf
  Return value
EndFunction
`),
      new AbortController().signal,
    );
    expect(result.diagnostics).toEqual([]);
    expect(validateIR(result.ir!)).toEqual([]);
    expect(result.ir!.functions.find((fn) => fn.name === "clamp")!.returnType.kind).toBe("number");
    expect(result.ir!.globals.find((variable) => variable.name === "answer")!.type.kind).toBe(
      "number",
    );
  });

  it("rejects incompatible return branches instead of sharing a numeric and string ABI", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(`
answer = Mixed(1)
Function Mixed(in number value)
  If value > 0 Then
    Return 1
  EndIf
  Return "invalid"
EndFunction
`),
      new AbortController().signal,
    );
    expect(result.diagnostics.map((entry) => entry.code)).toContain("BP2010");
  });

  it("preserves integer storage across comparisons, text, and number API arguments", async () => {
    const result = await new BasicPlusFrontend().compile(
      project(`
value = 2
If value = 2 Then
  text = "Value: " + value
  power = Math.Power(value, 2)
EndIf
`),
      new AbortController().signal,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir!.globals.find((variable) => variable.name === "value")!.type.kind).toBe(
      "integer",
    );
  });
});

describe("configurable formatting indentation", () => {
  it.each([2, 4] as const)(
    "formats nested blocks with %i spaces without changing tokens",
    (indentSize) => {
      const source = "If True Then\nWhile True\nLCD.Clear()\nEndWhile\nElse\nLCD.Update()\nEndIf\n";
      const formatted = formatBasicPlus(source, { indentSize });
      expect(formatted).toBe(
        `If True Then\n${" ".repeat(indentSize)}While True\n${" ".repeat(indentSize * 2)}LCD.Clear()\n${" ".repeat(indentSize)}EndWhile\nElse\n${" ".repeat(indentSize)}LCD.Update()\nEndIf\n`,
      );
      expect(formatBasicPlus(formatted, { indentSize })).toBe(formatted);
      expect(formatted.split("\n").map((line) => line.trim())).toEqual(
        source.split("\n").map((line) => line.trim()),
      );
    },
  );
  it("preserves the two-space default for existing callers", () => {
    const source = "If True Then\nLCD.Clear()\nEndIf\n";
    expect(formatBasicPlus(source)).toBe(formatBasicPlus(source, { indentSize: 2 }));
  });
});
