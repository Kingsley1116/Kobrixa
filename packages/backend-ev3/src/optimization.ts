import type {
  IRFunction,
  IRInstruction,
  IRTerminator,
  IRType,
  IRValue,
  KobrixaIR,
} from "@kobrixa/ir";

const canonical = (name: string): string => name.toLocaleLowerCase("en-US");
type PureInstruction = Extract<IRInstruction, { op: "assign" | "binary" | "unary" }>;
const isPure = (instruction: IRInstruction): instruction is PureInstruction =>
  instruction.op === "assign" || instruction.op === "binary" || instruction.op === "unary";

/** Keep whole functions, including calls in blocks that have not been proven dead. */
export function reachableFunctions(
  ir: KobrixaIR,
  retained: readonly string[],
  signal: AbortSignal,
): IRFunction[] {
  const functions = new Map(ir.functions.map((fn) => [canonical(fn.name), fn]));
  const reached = new Set<string>();
  const pending = [ir.program.entryFunction, ...retained].map(canonical);
  while (pending.length) {
    signal.throwIfAborted();
    const name = pending.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    for (const block of functions.get(name)?.blocks ?? [])
      for (const instruction of block.instructions)
        if (instruction.op === "call" || instruction.op === "thread-start")
          pending.push(canonical(instruction.functionName));
  }
  return ir.functions.filter((fn) => reached.has(canonical(fn.name)));
}

function variableNames(values: readonly IRValue[]): string[] {
  return values.flatMap((value) => (value.kind === "variable" ? [canonical(value.name)] : []));
}

function reads(instruction: IRInstruction | IRTerminator): string[] {
  switch (instruction.op) {
    case "assign":
    case "unary":
      return variableNames([instruction.value]);
    case "binary":
      return variableNames([instruction.left, instruction.right]);
    case "call":
    case "ev3-call":
      // Treat output arguments as reads too: a callee may leave them unwritten.
      return variableNames(instruction.args);
    case "branch":
      return variableNames([instruction.condition]);
    case "return":
      return instruction.value ? variableNames([instruction.value]) : [];
    default:
      return [];
  }
}

interface Site {
  block: string;
  index: number;
  instruction: IRInstruction | IRTerminator;
}

function accesses(fn: IRFunction, functions: ReadonlyMap<string, IRFunction>) {
  const definitions = new Map<string, Site[]>();
  const uses = new Map<string, Site[]>();
  const outputs = new Set<string>();
  const add = (map: Map<string, Site[]>, name: string, site: Site): void => {
    const entries = map.get(name) ?? [];
    entries.push(site);
    map.set(name, entries);
  };
  for (const block of fn.blocks) {
    for (const [index, instruction] of [...block.instructions, block.terminator].entries()) {
      const site = { block: block.id, index, instruction };
      for (const name of reads(instruction)) add(uses, name, site);
      if (instruction.op !== "jump" && "target" in instruction && instruction.target)
        add(definitions, canonical(instruction.target), site);
      if (instruction.op === "call") {
        const callee = functions.get(canonical(instruction.functionName));
        for (const [argumentIndex, value] of instruction.args.entries()) {
          if (value.kind !== "variable") continue;
          if (!callee || callee.parameters[argumentIndex]?.direction === "out") {
            const name = canonical(value.name);
            outputs.add(name);
            add(definitions, name, site);
          }
        }
      }
    }
  }
  return { definitions, uses, outputs };
}

/** Redirect adjacent pure scalar results without changing conversion or call semantics. */
export function eliminateCopies(
  fn: IRFunction,
  functions: ReadonlyMap<string, IRFunction>,
  signal: AbortSignal,
): IRFunction {
  const locals = new Map([...fn.parameters, ...fn.locals].map((v) => [canonical(v.name), v]));
  const { definitions, uses, outputs } = accesses(fn, functions);
  const removed = new Set<string>();
  const blocks = fn.blocks.map((block) => {
    signal.throwIfAborted();
    const instructions: IRInstruction[] = [];
    for (let index = 0; index < block.instructions.length; index += 1) {
      let instruction = block.instructions[index]!;
      while (isPure(instruction)) {
        const temporaryName = canonical(instruction.target);
        const temporary = locals.get(temporaryName);
        const next = block.instructions[index + 1];
        if (
          temporary?.scope !== "temporary" ||
          !["integer", "number", "boolean"].includes(temporary.type.kind) ||
          !fullDefinition(instruction, temporary.type) ||
          definitions.get(temporaryName)?.length !== 1 ||
          uses.get(temporaryName)?.length !== 1 ||
          outputs.has(temporaryName) ||
          next?.op !== "assign" ||
          next.value.kind !== "variable" ||
          canonical(next.value.name) !== temporaryName
        )
          break;
        const destination = locals.get(canonical(next.target));
        if (
          !destination ||
          destination.scope === "global" ||
          destination.type.kind !== temporary.type.kind
        )
          break;
        instruction = { ...instruction, target: next.target };
        removed.add(temporaryName);
        index += 1;
      }
      instructions.push(instruction);
    }
    return { ...block, instructions };
  });
  return removed.size
    ? { ...fn, blocks, locals: fn.locals.filter((v) => !removed.has(canonical(v.name))) }
    : fn;
}

function successors(terminator: IRTerminator): string[] {
  if (terminator.op === "jump") return [terminator.target];
  if (terminator.op === "branch") return [terminator.whenTrue, terminator.whenFalse];
  return [];
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}

// Some malformed IR operations only write one byte of a wider target. Never
// interpret such a write as a fresh value when deciding whether storage is reusable.
function fullDefinition(instruction: IRInstruction | IRTerminator, type: IRType): boolean {
  if (instruction.op === "assign") return true;
  if (instruction.op === "unary")
    return instruction.operator === "not"
      ? type.kind === "boolean"
      : ["integer", "number"].includes(type.kind);
  if (instruction.op !== "binary") return false;
  if (type.kind === "string") return instruction.operator === "+";
  const arithmetic = ["+", "-", "*", "/", "%"].includes(instruction.operator);
  return type.kind === "boolean" ? !arithmetic : arithmetic;
}

/** Each key is a reusable temporary; its neighbours must occupy distinct slots. */
export function temporaryInterference(
  fn: IRFunction,
  functions: ReadonlyMap<string, IRFunction>,
  signal: AbortSignal,
): ReadonlyMap<string, ReadonlySet<string>> {
  const graph = new Map<string, Set<string>>();
  const blocks = new Map(fn.blocks.map((block) => [block.id, block]));
  // Preserve the existing assembler's source-order entry convention. Invalid
  // or differently ordered IR does not receive speculative storage reuse.
  if (fn.blocks[0]?.id !== fn.entryBlock || blocks.size !== fn.blocks.length) return graph;
  const reached = new Set<string>();
  const pending = [fn.entryBlock];
  while (pending.length) {
    signal.throwIfAborted();
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    const block = blocks.get(id);
    if (!block) return graph;
    reached.add(id);
    pending.push(...successors(block.terminator));
  }
  const predecessors = new Map([...reached].map((id) => [id, [] as string[]]));
  for (const id of reached)
    for (const next of successors(blocks.get(id)!.terminator)) predecessors.get(next)!.push(id);
  const dominators = new Map(
    [...reached].map((id) => [id, new Set(id === fn.entryBlock ? [id] : reached)]),
  );
  let changed: boolean;
  do {
    signal.throwIfAborted();
    changed = false;
    for (const id of reached) {
      if (id === fn.entryBlock) continue;
      const incoming = predecessors.get(id)!;
      const common = new Set(
        [...dominators.get(incoming[0]!)!].filter((name) =>
          incoming.every((p) => dominators.get(p)!.has(name)),
        ),
      );
      common.add(id);
      if (!sameSet(common, dominators.get(id)!)) {
        dominators.set(id, common);
        changed = true;
      }
    }
  } while (changed);

  const { definitions, uses, outputs } = accesses(fn, functions);
  for (const variable of fn.locals) {
    const name = canonical(variable.name);
    const sites = definitions.get(name);
    if (
      variable.scope !== "temporary" ||
      variable.type.kind === "array" ||
      variable.type.kind === "void" ||
      outputs.has(name) ||
      sites?.length !== 1
    )
      continue;
    const definition = sites[0]!;
    if (!reached.has(definition.block) || !fullDefinition(definition.instruction, variable.type))
      continue;
    if (
      (uses.get(name) ?? []).every(
        (use) =>
          dominators.get(use.block)?.has(definition.block) &&
          (use.block !== definition.block || definition.index < use.index),
      )
    )
      graph.set(name, new Set());
  }
  if (!graph.size) return graph;

  const use = (instruction: IRInstruction | IRTerminator): string[] =>
    reads(instruction).filter((name) => graph.has(name));
  const def = (instruction: IRInstruction): string[] =>
    "target" in instruction && instruction.target && graph.has(canonical(instruction.target))
      ? [canonical(instruction.target)]
      : [];
  const liveIn = new Map([...reached].map((id) => [id, new Set<string>()]));
  const liveOut = new Map([...reached].map((id) => [id, new Set<string>()]));
  const order = [...reached].reverse();
  do {
    signal.throwIfAborted();
    changed = false;
    for (const id of order) {
      const block = blocks.get(id)!;
      const out = new Set(successors(block.terminator).flatMap((next) => [...liveIn.get(next)!]));
      const live = new Set([...out, ...use(block.terminator)]);
      for (let i = block.instructions.length - 1; i >= 0; i -= 1) {
        const instruction = block.instructions[i]!;
        for (const name of def(instruction)) live.delete(name);
        for (const name of use(instruction)) live.add(name);
      }
      liveOut.set(id, out);
      if (!sameSet(live, liveIn.get(id)!)) {
        liveIn.set(id, live);
        changed = true;
      }
    }
  } while (changed);
  const interfere = (names: Set<string>): void => {
    for (const left of names)
      for (const right of names) if (left !== right) graph.get(left)!.add(right);
  };
  for (const id of reached) {
    signal.throwIfAborted();
    const block = blocks.get(id)!;
    const live = new Set([...liveOut.get(id)!, ...use(block.terminator)]);
    interfere(live);
    for (let i = block.instructions.length - 1; i >= 0; i -= 1) {
      const instruction = block.instructions[i]!;
      const inputs = use(instruction),
        outputs = def(instruction);
      // IR lowering can expand into multiple VM instructions. Even a last-use
      // input must not alias this instruction's output or another input.
      interfere(new Set([...live, ...inputs, ...outputs]));
      for (const name of outputs) live.delete(name);
      for (const name of inputs) live.add(name);
    }
  }
  return graph;
}
