import assert from "node:assert/strict";
import { test } from "node:test";
import { EV3Backend } from "../../packages/backend-ev3/dist/index.js";
import { compilerFixtures, runCompilerRegression } from "./support/compiler-regressions.mjs";
import { decode, VM } from "./support/ev3-vm.mjs";

const variable = (name) => ({ kind: "variable", name });
const integer = (value) => ({ kind: "integer", value });
const text = (value) => ({ kind: "string", value });
const display = (value) => ({
  op: "ev3-call",
  operation: "LCD.Text",
  args: [integer(1), integer(0), integer(0), integer(1), value],
});
const block = (id, instructions, terminator) => ({ id, instructions, terminator });
const program = (blocks, globals = []) => ({
  version: 1,
  program: { name: "optimization", entryFunction: "main" },
  globals,
  functions: [
    {
      name: "main",
      parameters: [],
      returnType: { kind: "void" },
      locals: [],
      entryBlock: "entry",
      blocks,
    },
  ],
  resources: [],
  sourceFiles: [],
});
async function compile(ir, optimize = true, retainFunctions = []) {
  const result = await new EV3Backend({ optimize, retainFunctions }).compile(
    ir,
    new AbortController().signal,
  );
  assert.deepEqual(result.diagnostics, []);
  const decoded = decode(result.rbf);
  const run = new VM(decoded).run();
  assert.equal(run.status, "ended", run.error);
  return {
    ...result,
    decoded,
    run,
    texts: run.trace.filter((entry) => entry.op === "UI_DRAW.TEXT").map((entry) => entry.args[3]),
    values: run.trace.filter((entry) => entry.op === "UI_DRAW.VALUE").map((entry) => entry.args[3]),
  };
}

for (const fixture of compilerFixtures) {
  test(`optimization preserves regression: ${fixture.name}`, async () => {
    const execute = (bytes) => new VM(decode(bytes)).run();
    const baseline = await runCompilerRegression(fixture, execute, { optimize: false });
    const optimized = await runCompilerRegression(fixture, execute, { optimize: true });
    assert(optimized.bytes <= baseline.bytes);
  });
}

test("scratch reuse keeps both operands alive and bounds repeated text conversions", async () => {
  const ir = program(
    [
      block(
        "entry",
        [
          { op: "assign", target: "left", value: integer(12) },
          { op: "assign", target: "right", value: { kind: "number", value: 3.5 } },
          ...Array.from({ length: 40 }, () => [
            {
              op: "binary",
              target: "message",
              operator: "+",
              left: variable("left"),
              right: variable("right"),
            },
            display(variable("message")),
          ]).flat(),
        ],
        { op: "return" },
      ),
    ],
    [
      { name: "left", type: { kind: "integer" }, scope: "global" },
      { name: "right", type: { kind: "number" }, scope: "global" },
      { name: "message", type: { kind: "string" }, scope: "global" },
    ],
  );
  const snapshot = structuredClone(ir);
  const baseline = await compile(ir, false);
  const optimized = await compile(ir);
  assert.deepEqual(optimized.texts, Array(40).fill("123.5"));
  assert.deepEqual(optimized.texts, baseline.texts);
  assert(optimized.decoded.objects[0].local < 1024);
  assert(baseline.decoded.objects[0].local > 20000);
  assert(optimized.rbf.length < baseline.rbf.length);
  assert.deepEqual(ir, snapshot, "optimization must not mutate the caller's IR");
  assert.deepEqual((await compile(ir)).rbf, optimized.rbf);
});

for (const first of ["yes", "no"]) {
  for (const condition of [true, false]) {
    test(`conditional fallthrough to ${first} preserves ${condition}`, async () => {
      const choices = ["yes", "no"].map((id) =>
        block(id, [display(text(id))], { op: "jump", target: "done" }),
      );
      if (first === "no") choices.reverse();
      const ir = program(
        [
          block(
            "entry",
            [{ op: "assign", target: "flag", value: { kind: "boolean", value: condition } }],
            { op: "branch", condition: variable("flag"), whenTrue: "yes", whenFalse: "no" },
          ),
          ...choices,
          block("done", [], { op: "return" }),
        ],
        [{ name: "flag", type: { kind: "boolean" }, scope: "global" }],
      );
      const optimized = await compile(ir);
      assert.deepEqual(optimized.texts, [condition ? "yes" : "no"]);
      assert.equal(
        optimized.decoded.objects[0].ins.filter((i) => i.name.startsWith("JR")).length,
        2,
      );
      assert.deepEqual(optimized.texts, (await compile(ir, false)).texts);
    });
  }
}

test("constant branches and empty fallthrough blocks emit no jumps", async () => {
  const result = await compile(
    program([
      block("entry", [], {
        op: "branch",
        condition: { kind: "boolean", value: false },
        whenTrue: "end",
        whenFalse: "next",
      }),
      block("next", [], { op: "jump", target: "last" }),
      block("last", [display(text("reached"))], {
        op: "branch",
        condition: { kind: "boolean", value: true },
        whenTrue: "end",
        whenFalse: "entry",
      }),
      block("end", [], { op: "return" }),
    ]),
  );
  assert.deepEqual(result.texts, ["reached"]);
  assert(!result.decoded.objects[0].ins.some((i) => i.name.startsWith("JR")));
});

test("unknown jump targets still produce diagnostics", async () => {
  for (const optimize of [false, true]) {
    const result = await new EV3Backend({ optimize }).compile(
      program([block("entry", [], { op: "jump", target: "missing" })]),
      new AbortController().signal,
    );
    assert(result.diagnostics.some((d) => d.code === "EV31003"));
    assert.equal(result.rbf, undefined);
  }
});

const temporary = (name, kind = "integer") => ({ name, type: { kind }, scope: "temporary" });
const helper = (name, instructions, locals = []) => ({
  name,
  parameters: [],
  returnType: { kind: "void" },
  locals,
  entryBlock: "entry",
  blocks: [block("entry", instructions, { op: "return" })],
});
const names = (result) =>
  result.listing
    .trim()
    .split("\n")
    .map((line) => line.split("\t")[1]);

test("pruning removes an unused recursive component before expansion", async () => {
  const ir = program([block("entry", [display(text("main"))], { op: "return" })]);
  ir.functions.push(helper("unused", [{ op: "call", functionName: "unused", args: [] }]));
  const baseline = await compile(ir, false);
  const optimized = await compile(ir);
  assert.equal(baseline.decoded.objects.length, 33);
  assert.deepEqual(names(optimized), ["main"]);
  assert.deepEqual(optimized.texts, baseline.texts);
});

test("retained functions are case-insensitive roots with complete call dependencies", async () => {
  const ir = program([block("entry", [], { op: "return" })]);
  ir.functions.push(
    helper("dependency", []),
    helper("retained", [{ op: "call", functionName: "DEPENDENCY", args: [] }]),
    helper("unused", []),
  );
  assert.deepEqual(names(await compile(ir)), ["main"]);
  const snapshot = structuredClone(ir);
  const retained = await compile(ir, true, ["ReTaInEd"]);
  assert.deepEqual(names(retained), ["main", "dependency", "retained"]);
  assert.deepEqual(ir, snapshot);
  assert.deepEqual((await compile(ir, true, ["retained"])).rbf, retained.rbf);
  for (const optimize of [false, true]) {
    const result = await new EV3Backend({ optimize, retainFunctions: ["typo"] }).compile(
      ir,
      new AbortController().signal,
    );
    assert(result.diagnostics.some((d) => d.code === "EV32003" && d.message.includes("typo")));
    assert.equal(result.rbf, undefined);
  }
});

test("nested background threads remain reachable after main ends", async () => {
  const ir = program([
    block("entry", [{ op: "thread-start", functionName: "OUTER" }], { op: "return" }),
  ]);
  ir.functions.push(
    helper("unused", []),
    helper("outer", [{ op: "thread-start", functionName: "INNER" }, display(text("outer"))]),
    helper("inner", [display(text("inner"))]),
  );
  const optimized = await compile(ir);
  assert.deepEqual(names(optimized), ["main", "outer", "inner", "thread:outer", "thread:inner"]);
  assert.equal(optimized.run.scheduler.threadsStarted, 2);
  assert.deepEqual(optimized.texts.toSorted(), ["inner", "outer"]);
  assert.deepEqual(optimized.texts, (await compile(ir, false)).texts);
});

test("unused-function lowering errors retain their original diagnostic and source location", async () => {
  const span = {
    file: "library.bp",
    start: { line: 9, column: 2, offset: 90 },
    end: { line: 9, column: 8, offset: 96 },
  };
  for (const instruction of [
    { op: "call", functionName: "missing", args: [], span },
    { op: "ev3-call", operation: "Missing.Operation", args: [], span },
    { op: "thread-start", functionName: "missing", span },
    { op: "assign", target: "undeclared", value: integer(3), span },
  ]) {
    const ir = program([block("entry", [], { op: "return" })]);
    ir.functions.push(helper("unused", [instruction]));
    const baseline = await new EV3Backend({ optimize: false }).compile(
      ir,
      new AbortController().signal,
    );
    const optimized = await new EV3Backend().compile(ir, new AbortController().signal);
    assert(baseline.diagnostics.length > 0);
    assert.deepEqual(optimized.diagnostics, baseline.diagnostics);
    assert.equal(optimized.rbf, undefined);
  }
});

test("pruning preserves global runtime storage even when only unused functions request it", async () => {
  const ir = program(
    [
      block(
        "entry",
        [{ op: "assign", target: "value", value: integer(7) }, display(variable("value"))],
        { op: "return" },
      ),
    ],
    [{ name: "value", type: { kind: "integer" }, scope: "global" }],
  );
  ir.functions.push(
    helper(
      "unused",
      [
        { op: "ev3-call", operation: "Thread.CreateMutex", args: [], target: "mutex" },
        { op: "ev3-call", operation: "LCD.StopUpdate", args: [] },
        { op: "ev3-call", operation: "Time.Get9", args: [], target: "timer" },
      ],
      [temporary("mutex"), temporary("timer")],
    ),
  );
  const baseline = await compile(ir, false);
  const optimized = await compile(ir);
  assert.equal(optimized.decoded.info.globalBytes, baseline.decoded.info.globalBytes);
  assert.deepEqual(names(optimized), ["main", "mutex:try-acquire"]);
  assert.deepEqual(optimized.values, [7]);
  assert.deepEqual(optimized.values, baseline.values);
});

test("IR string storage is reused without aliasing concatenation operands", async () => {
  const instructions = [],
    locals = [],
    expected = [];
  for (let i = 0; i < 20; i++) {
    const first = `first${i}`,
      second = `second${i}`,
      joined = `joined${i}`;
    locals.push(...[first, second, joined].map((name) => temporary(name, "string")));
    instructions.push(
      { op: "assign", target: first, value: text(`value:${i},`) },
      { op: "assign", target: second, value: text("tail") },
      {
        op: "binary",
        target: joined,
        operator: "+",
        left: variable(first),
        right: variable(second),
      },
      display(variable(joined)),
    );
    expected.push(`value:${i},tail`);
  }
  const ir = program([block("entry", instructions, { op: "return" })]);
  ir.functions[0].locals = locals;
  const optimized = await compile(ir);
  const baseline = await compile(ir, false);
  assert.deepEqual(optimized.texts, expected);
  assert.deepEqual(optimized.texts, baseline.texts);
  assert.equal(optimized.decoded.objects[0].local, 3 * 252);
  assert.equal(baseline.decoded.objects[0].local, 60 * 252);
});

test("storage reuse does not replace a skipped branch's initial value with stale data", async () => {
  for (const flag of [false, true]) {
    const ir = program([
      block(
        "entry",
        [{ op: "assign", target: "seed", value: integer(99) }, display(variable("seed"))],
        {
          op: "branch",
          condition: { kind: "boolean", value: flag },
          whenTrue: "yes",
          whenFalse: "join",
        },
      ),
      block("yes", [{ op: "assign", target: "conditional", value: integer(7) }], {
        op: "jump",
        target: "join",
      }),
      block("join", [display(variable("conditional"))], { op: "return" }),
    ]);
    ir.functions[0].locals = [temporary("seed"), temporary("conditional")];
    const optimized = await compile(ir);
    assert.deepEqual(optimized.values, [99, flag ? 7 : 0]);
    assert.deepEqual(optimized.values, (await compile(ir, false)).values);
  }
});

test("a temporary live across a loop is not overwritten by loop-local results", async () => {
  const ir = program(
    [
      block(
        "entry",
        [
          { op: "assign", target: "outer", value: integer(3) },
          { op: "assign", target: "flag", value: { kind: "boolean", value: true } },
        ],
        { op: "jump", target: "header" },
      ),
      block("header", [], {
        op: "branch",
        condition: variable("flag"),
        whenTrue: "body",
        whenFalse: "done",
      }),
      block(
        "body",
        [
          { op: "assign", target: "inner", value: integer(42) },
          display(variable("inner")),
          { op: "assign", target: "flag", value: { kind: "boolean", value: false } },
        ],
        { op: "jump", target: "header" },
      ),
      block("done", [display(variable("outer"))], { op: "return" }),
    ],
    [{ name: "flag", type: { kind: "boolean" }, scope: "global" }],
  );
  ir.functions[0].locals = [temporary("outer"), temporary("inner")];
  const optimized = await compile(ir);
  assert.deepEqual(optimized.values, [42, 3]);
  assert.deepEqual(optimized.values, (await compile(ir, false)).values);
});

test("copy forwarding removes scalar moves while retaining widening conversions", async () => {
  const ir = program([
    block(
      "entry",
      [
        { op: "binary", target: "calculated", operator: "+", left: integer(10), right: integer(3) },
        { op: "assign", target: "result", value: variable("calculated") },
        {
          op: "binary",
          target: "integerResult",
          operator: "+",
          left: integer(5),
          right: integer(2),
        },
        { op: "assign", target: "wide", value: variable("integerResult") },
        display(variable("result")),
        display(variable("wide")),
      ],
      { op: "return" },
    ),
  ]);
  ir.functions[0].locals = [
    temporary("calculated"),
    { ...temporary("result"), scope: "local" },
    temporary("integerResult"),
    { ...temporary("wide", "number"), scope: "local" },
  ];
  const baseline = await compile(ir, false);
  const optimized = await compile(ir);
  const moves = (result, opcode) =>
    result.decoded.objects[0].ins.filter((i) => i.name === opcode).length;
  assert.equal(moves(optimized, "MOVE32_32"), moves(baseline, "MOVE32_32") - 1);
  assert.equal(moves(optimized, "MOVE32_F"), moves(baseline, "MOVE32_F"));
  assert.deepEqual(optimized.values, [13, 7]);
  assert.deepEqual(optimized.values, baseline.values);
});
