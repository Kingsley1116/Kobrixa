import { describe, expect, it } from "vitest";
import type {
  IRBasicBlock,
  IRFunction,
  IRInstruction,
  IRType,
  IRVariable,
  KobrixaIR,
} from "@kobrixa/ir";
import { eliminateCopies, reachableFunctions, temporaryInterference } from "./optimization.js";

const signal = new AbortController().signal;
const ref = (name: string) => ({ kind: "variable" as const, name });
const literal = (value: number) => ({ kind: "integer" as const, value });
const temporary = (name: string, type: IRType = { kind: "integer" }): IRVariable => ({
  name,
  type,
  scope: "temporary",
});
const assign = (target: string, value: number | string): IRInstruction => ({
  op: "assign",
  target,
  value: typeof value === "number" ? literal(value) : ref(value),
});
const add = (target: string, left: string, right: string): IRInstruction => ({
  op: "binary",
  target,
  operator: "+",
  left: ref(left),
  right: ref(right),
});
const consume = (...names: string[]): IRInstruction => ({
  op: "ev3-call",
  operation: "test.consume",
  args: names.map(ref),
});
const block = (
  id: string,
  instructions: IRInstruction[],
  terminator: IRBasicBlock["terminator"] = { op: "return" },
): IRBasicBlock => ({ id, instructions, terminator });
const fn = (
  blocks: IRBasicBlock[],
  locals: IRVariable[] = [],
  overrides: Partial<IRFunction> = {},
): IRFunction => ({
  name: "main",
  parameters: [],
  returnType: { kind: "void" },
  locals,
  entryBlock: "entry",
  blocks,
  ...overrides,
});
const program = (functions: IRFunction[]): KobrixaIR => ({
  version: 1,
  program: { name: "optimization", entryFunction: "main" },
  functions,
  globals: [],
  resources: [],
  sourceFiles: [],
});
const byName = (functions: IRFunction[]) =>
  new Map(functions.map((f) => [f.name.toLowerCase(), f]));
const call = (functionName: string, ...names: string[]): IRInstruction => ({
  op: "call",
  functionName,
  args: names.map(ref),
});
const interfere = (f: IRFunction, functions = [f]) =>
  temporaryInterference(f, byName(functions), signal);

describe("function reachability", () => {
  const functions = [
    fn([block("entry", [call("HELPER"), { op: "thread-start", functionName: "Worker" }])]),
    fn([block("entry", [call("cycle")])], [], { name: "helper" }),
    fn([block("entry", [call("helper")])], [], { name: "cycle" }),
    fn([block("entry", [{ op: "thread-start", functionName: "nested" }])], [], { name: "worker" }),
    fn([block("entry", [])], [], { name: "nested" }),
    fn([block("entry", [call("unused")])], [], { name: "unused" }),
    fn([block("entry", [call("unused")])], [], { name: "retained" }),
  ];
  it("keeps calls, nested thread roots and recursive components in declaration order", () => {
    const input = program(functions);
    const snapshot = structuredClone(input);
    expect(reachableFunctions(input, [], signal).map((f) => f.name)).toEqual([
      "main",
      "helper",
      "cycle",
      "worker",
      "nested",
    ]);
    expect(input).toEqual(snapshot);
  });
  it("follows retained roots case-insensitively, including their dependencies", () => {
    expect(reachableFunctions(program(functions), ["RETAINED"], signal)).toEqual(functions);
  });
  it("does not guess that a conditional block can never execute", () => {
    const main = fn([block("entry", []), block("later", [call("unused")])]);
    expect(
      reachableFunctions(program([main, ...functions.slice(1)]), [], signal).map((f) => f.name),
    ).toEqual(["main", "unused"]);
  });
});

describe("adjacent scalar copy elimination", () => {
  it("redirects a chain into a local, retaining the original operation and input IR", () => {
    const f = fn(
      [block("entry", [assign("a", 7), assign("b", "A"), assign("result", "b")])],
      [temporary("a"), temporary("b"), { ...temporary("result"), scope: "local" }],
    );
    const snapshot = structuredClone(f);
    const optimized = eliminateCopies(f, byName([f]), signal);
    expect(optimized.blocks[0]!.instructions).toEqual([assign("result", 7)]);
    expect(optimized.locals.map((v) => v.name)).toEqual(["result"]);
    expect(f).toEqual(snapshot);
  });

  it.each(["number", "integer", "boolean"] as const)(
    "keeps the exact %s type when writing an output parameter",
    (kind) => {
      const f = fn(
        [block("entry", [assign("a", "input"), assign("output", "a")])],
        [temporary("a", { kind })],
        {
          parameters: [
            { name: "input", type: { kind }, scope: "parameter" },
            { name: "output", type: { kind }, scope: "parameter", direction: "out" },
          ],
        },
      );
      expect(eliminateCopies(f, byName([f]), signal).blocks[0]!.instructions).toEqual([
        assign("output", "input"),
      ]);
    },
  );

  it("preserves conversions, global stores, multiple uses and non-adjacent copies", () => {
    const cases = [
      fn(
        [block("entry", [assign("a", 1), assign("wide", "a")])],
        [temporary("a"), { ...temporary("wide", { kind: "number" }), scope: "local" }],
      ),
      fn([block("entry", [assign("a", 1), assign("global", "a")])], [temporary("a")]),
      fn(
        [block("entry", [assign("a", 1), assign("local", "a"), consume("a")])],
        [temporary("a"), { ...temporary("local"), scope: "local" }],
      ),
      fn(
        [block("entry", [assign("a", 1), consume("local"), assign("local", "a")])],
        [temporary("a"), { ...temporary("local"), scope: "local" }],
      ),
    ];
    for (const f of cases) expect(eliminateCopies(f, byName([f]), signal)).toBe(f);
  });

  it("excludes strings, arrays, API/call results and temporaries passed as outputs", () => {
    for (const type of [{ kind: "string" }, { kind: "array", element: "number" }] as IRType[]) {
      const f = fn(
        [block("entry", [assign("a", "input"), assign("local", "a")])],
        [temporary("a", type), { ...temporary("local", type), scope: "local" }],
      );
      expect(eliminateCopies(f, byName([f]), signal)).toBe(f);
    }
    for (const producer of [
      { op: "call", functionName: "produce", args: [], target: "a" },
      { op: "ev3-call", operation: "Time.Get1", args: [], target: "a" },
    ] as IRInstruction[]) {
      const f = fn(
        [block("entry", [producer, assign("local", "a")])],
        [temporary("a"), { ...temporary("local"), scope: "local" }],
      );
      expect(eliminateCopies(f, byName([f]), signal)).toBe(f);
    }
    const writer = fn([block("entry", [])], [], {
      name: "writer",
      parameters: [{ ...temporary("out"), scope: "parameter", direction: "out" }],
    });
    const f = fn(
      [block("entry", [assign("a", 1), call("writer", "a"), assign("a", 2), assign("local", "a")])],
      [temporary("a"), { ...temporary("local"), scope: "local" }],
    );
    expect(eliminateCopies(f, byName([f, writer]), signal)).toBe(f);
  });
});

describe("temporary liveness", () => {
  it("reuses disjoint lifetimes but separates every operand of one instruction", () => {
    const f = fn(
      [
        block("entry", [
          assign("a", 1),
          assign("b", 2),
          add("sum", "a", "b"),
          consume("sum"),
          assign("later", 3),
          consume("later"),
        ]),
      ],
      ["a", "b", "sum", "later"].map((name) => temporary(name)),
    );
    const graph = interfere(f);
    expect(graph.size).toBe(4);
    for (const name of ["a", "b", "sum"]) {
      expect([...graph.get(name)!].sort()).toEqual(
        ["a", "b", "sum"].filter((other) => other !== name).sort(),
      );
    }
    expect(graph.get("later")?.size).toBe(0);
  });

  it("allows fixed-capacity string temporaries with separate lifetimes", () => {
    const f = fn(
      [
        block("entry", [
          { op: "assign", target: "a", value: { kind: "string", value: "first" } },
          consume("a"),
          { op: "assign", target: "b", value: { kind: "string", value: "second" } },
          consume("b"),
        ]),
      ],
      [temporary("a", { kind: "string" }), temporary("b", { kind: "string" })],
    );
    expect([...interfere(f)].map(([name, neighbours]) => [name, neighbours.size])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("pins a value defined on only one branch before a merge", () => {
    const f = fn(
      [
        block("entry", [assign("always", 1)], {
          op: "branch",
          condition: ref("flag"),
          whenTrue: "yes",
          whenFalse: "join",
        }),
        block("yes", [assign("conditional", 2)], { op: "jump", target: "join" }),
        block("join", [consume("always", "conditional")]),
      ],
      [temporary("always"), temporary("conditional")],
    );
    expect([...interfere(f).keys()]).toEqual(["always"]);
  });

  it("keeps values live across loop backedges and pins a first-iteration read before definition", () => {
    const f = fn(
      [
        block("entry", [assign("outer", 1)], { op: "jump", target: "header" }),
        block("header", [consume("early")], {
          op: "branch",
          condition: ref("flag"),
          whenTrue: "body",
          whenFalse: "done",
        }),
        block("body", [assign("early", 2), assign("inner", 3), consume("inner")], {
          op: "jump",
          target: "header",
        }),
        block("done", [consume("outer")]),
      ],
      [temporary("outer"), temporary("early"), temporary("inner")],
    );
    const graph = interfere(f);
    expect(graph.has("early")).toBe(false);
    expect(graph.get("outer")?.has("inner")).toBe(true);
  });

  it("pins named locals, arrays, multiple definitions, call/API outputs and output arguments", () => {
    const writer = fn([block("entry", [])], [], {
      name: "writer",
      parameters: [{ ...temporary("out"), scope: "parameter", direction: "out" }],
    });
    const f = fn(
      [
        block("entry", [
          assign("named", 1),
          assign("array", "otherArray"),
          assign("twice", 1),
          assign("twice", 2),
          { ...call("produce"), target: "called" } as IRInstruction,
          { op: "ev3-call", operation: "Time.Get1", args: [], target: "api" },
          assign("output", 3),
          call("writer", "output"),
          consume("named", "array", "twice", "called", "api", "output"),
        ]),
      ],
      [
        { ...temporary("named"), scope: "local" },
        temporary("array", { kind: "array", element: "number" }),
        ...["twice", "called", "api", "output"].map((name) => temporary(name)),
      ],
    );
    expect(interfere(f, [f, writer]).size).toBe(0);
  });

  it("pins undefined, self-read and unreachable uses instead of inventing initial values", () => {
    const f = fn(
      [
        block("entry", [assign("self", "self"), assign("unreachableUse", 1), consume("undefined")]),
        block("unreachable", [consume("unreachableUse")]),
      ],
      ["self", "unreachableUse", "undefined"].map((name) => temporary(name)),
    );
    expect(interfere(f).size).toBe(0);
  });

  it("honours cancellation during optimization", () => {
    const f = fn([block("entry", [assign("a", 1)])], [temporary("a")]);
    const aborted = AbortSignal.abort();
    expect(() => reachableFunctions(program([f]), [], aborted)).toThrow();
    expect(() => eliminateCopies(f, byName([f]), aborted)).toThrow();
    expect(() => temporaryInterference(f, byName([f]), aborted)).toThrow();
  });
});
