import {
  getEV3Operation,
  type IRBasicBlock,
  type IRFunction,
  type IRInstruction,
  type IRType,
  type IRValue,
  type IRVariable,
  type KobrixaIR,
  type SourceSpan,
} from "@kobrixa/ir";
import { checkedText, numeric, previewText, scalarOperation } from "./scalar-operations.js";
import {
  VirtualDevice,
  type PreviewValue,
  type PreviewInputs,
  type PreviewDeviceSnapshot,
  type PreviewInvokeContext,
  type PreviewInvokeResult,
} from "./virtual-device.js";

/** Device adapters provide peripherals without coupling the interpreter to a world or UI. */
export interface RuntimeDevice {
  invoke(
    operation: string,
    args: PreviewValue[],
    nowMs: number,
    context?: PreviewInvokeContext,
  ): PreviewInvokeResult;
  advance(elapsedMs: number): void;
  snapshot(): PreviewDeviceSnapshot;
  setInputs(inputs: PreviewInputs): void;
}
export interface PreviewRuntimeOptions {
  clock?: "internal" | "external";
  /** Unlimited sessions are only permitted with an external world clock; tick bounds still apply. */
  sessionInstructionLimit?: number | null;
  randomSeed?: number;
}
export interface RuntimeTickState {
  status: PreviewStatus;
  instructions: number;
  elapsedMs: number;
  error?: PreviewSnapshot["error"];
}

export type PreviewStatus = "ready" | "running" | "paused" | "completed" | "stopped" | "error";

export interface PreviewSnapshot {
  status: PreviewStatus;
  device: PreviewDeviceSnapshot;
  globals: Record<string, PreviewValue>;
  locals: Record<string, PreviewValue>;
  currentSpan?: SourceSpan;
  callStack: string[];
  instructions: number;
  elapsedMs: number;
  threadCount: number;
  truncatedVariables?: string[];
  omittedVariableCount?: number;
  error?: { message: string; span?: SourceSpan };
}

export const PREVIEW_LIMITS = {
  instructionsPerSlice: 50_000,
  instructions: 10_000_000,
  callDepth: 64,
  threads: 16,
  arrayElements: 65_536,
  rowHandles: 256,
  vectorOperations: 1_000_000,
  liveArrayElements: 1_048_576,
  liveVariables: 32_768,
  snapshotValues: 2_048,
  snapshotVariablesPerScope: 200,
  snapshotArrayElements: 64,
  workPerSlice: 1_000_000,
} as const;

interface Cell {
  type: IRType;
  value: PreviewValue;
  name: string;
}
interface Frame {
  fn: IRFunction;
  cells: Map<string, Cell>;
  block: IRBasicBlock;
  index: number;
  outputs: Array<{ parameter: string; caller: Cell }>;
  target?: Cell;
}
interface Thread {
  id: number;
  root: string;
  stack: Frame[];
  wakeAt: number;
  waitingForFunction?: string;
  waitingForMutex?: number;
  rootPending?: boolean;
}
type DeviceResult = PreviewInvokeResult;
const key = (name: string) => name.toLowerCase();
const terminal = (status: PreviewStatus) => ["completed", "stopped", "error"].includes(status);

/** Browser-only interpreter. Every slice has a hard instruction bound and uses virtual time. */
export class PreviewRuntime {
  readonly #device: RuntimeDevice;
  readonly #externalClock: boolean;
  readonly #sessionInstructionLimit: number;
  readonly #callsites = new Map<IRInstruction, PreviewInvokeContext>();
  readonly #functions = new Map<string, IRFunction>();
  readonly #globals = new Map<string, Cell>();
  readonly #threads: Thread[] = [];
  readonly #rows = new Map<number, PreviewValue[]>();
  readonly #deletedArrays = new WeakSet<PreviewValue[]>();
  readonly #stringArrays = new WeakSet<PreviewValue[]>();
  readonly #mutexes = new Map<number, number | null>();
  #status: PreviewStatus = "ready";
  #elapsedMs = 0;
  #instructions = 0;
  #cursor = 0;
  #nextThread = 1;
  #nextRow = 1;
  #randomState = 0x4b4f4252;
  #currentSpan: SourceSpan | undefined;
  #currentThread: Thread | undefined;
  #error: PreviewSnapshot["error"];
  #heapDirty = true;
  #sliceWork = 0;

  constructor(ir: KobrixaIR, device?: RuntimeDevice, options: PreviewRuntimeOptions = {}) {
    this.#externalClock = options.clock === "external";
    this.#sessionInstructionLimit =
      this.#externalClock && options.sessionInstructionLimit === null
        ? Infinity
        : (options.sessionInstructionLimit ?? PREVIEW_LIMITS.instructions);
    this.#device =
      device ??
      new VirtualDevice({
        ...(ir.program.runtimeDirectory ? { runtimeDirectory: ir.program.runtimeDirectory } : {}),
      });
    try {
      if (
        !(this.#externalClock && options.sessionInstructionLimit === null) &&
        (!Number.isSafeInteger(this.#sessionInstructionLimit) || this.#sessionInstructionLimit < 1)
      )
        throw new Error("Invalid runtime session instruction limit.");
      if (options.randomSeed !== undefined)
        this.#randomState = options.randomSeed >>> 0 || 0x4b4f4252;
      if (ir.version !== 1) throw new Error("Unsupported preview IR version.");
      if (ir.functions.length > 4096 || ir.globals.length > 4096)
        throw new Error("The program exceeds the preview's function or variable limit.");
      let mailboxHandle = 0;
      for (const fn of ir.functions) {
        this.#functions.set(key(fn.name), fn);
        for (const block of fn.blocks)
          for (const [index, instruction] of block.instructions.entries()) {
            if (instruction.op !== "ev3-call") continue;
            const context: PreviewInvokeContext = {
              callsite: `${key(fn.name)}:${block.id}:${index}`,
            };
            if (
              instruction.operation === "Mailbox.Create" ||
              instruction.operation === "Mailbox.CreateForNumber"
            )
              context.mailboxHandle = mailboxHandle++;
            this.#callsites.set(instruction, context);
          }
      }
      for (const variable of ir.globals)
        this.#globals.set(key(variable.name), this.newCell(variable));
      const entry = this.functionFor(ir.program.entryFunction);
      const thread = {
        id: this.#nextThread++,
        root: key(entry.name),
        stack: [this.frame(entry)],
        wakeAt: 0,
      };
      this.#threads.push(thread);
      this.#currentThread = thread;
      this.#currentSpan = entry.blocks.find((block) => block.id === entry.entryBlock)
        ?.instructions[0]?.span;
    } catch (error) {
      this.fail(error);
    }
  }

  get status(): PreviewStatus {
    return this.#status;
  }

  /** Run against the shared world clock. This never advances peripherals or builds a debug snapshot. */
  executeAt(nowMs: number, instructionBudget = 2000): RuntimeTickState {
    try {
      if (!this.#externalClock) throw new Error("executeAt requires an external world clock.");
      if (!Number.isFinite(nowMs) || nowMs < this.#elapsedMs)
        throw new Error("External runtime time must be finite and monotonic.");
      if (!Number.isFinite(instructionBudget))
        throw new Error("Invalid runtime instruction budget.");
      this.#elapsedMs = nowMs;
      this.executeBudget(instructionBudget);
    } catch (error) {
      this.fail(error);
    }
    return {
      status: this.#status,
      instructions: this.#instructions,
      elapsedMs: this.#elapsedMs,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  resume(): PreviewSnapshot {
    if (this.#status === "ready" || this.#status === "paused") this.#status = "running";
    return this.getSnapshot();
  }

  pause(): PreviewSnapshot {
    if (this.#status === "running" || this.#status === "ready") this.#status = "paused";
    return this.getSnapshot();
  }

  stop(): PreviewSnapshot {
    if (!terminal(this.#status)) this.finish("stopped");
    return this.getSnapshot();
  }

  setInputs(inputs: PreviewInputs): PreviewSnapshot {
    try {
      this.#device.setInputs(inputs);
    } catch (error) {
      this.fail(error);
    }
    return this.getSnapshot();
  }

  runSlice(instructionBudget: number, elapsedMs: number): PreviewSnapshot {
    if (this.#status !== "running") return this.getSnapshot();
    try {
      if (this.#externalClock) throw new Error("Use executeAt with the external world clock.");
      if (!Number.isFinite(instructionBudget) || !Number.isFinite(elapsedMs) || elapsedMs < 0)
        throw new Error("Invalid preview instruction budget or elapsed time.");
      this.advance(Math.min(elapsedMs, 60_000));
      this.executeBudget(instructionBudget);
    } catch (error) {
      this.fail(error);
    }
    return this.getSnapshot();
  }

  private executeBudget(instructionBudget: number): void {
    this.#sliceWork = 0;
    const budget = Math.max(
      0,
      Math.min(PREVIEW_LIMITS.instructionsPerSlice, Math.floor(instructionBudget)),
    );
    for (
      let count = 0;
      count < budget && this.#status === "running" && this.#sliceWork < PREVIEW_LIMITS.workPerSlice;
      count++
    ) {
      const thread = this.nextThread();
      if (!thread) break;
      this.execute(thread);
      this.checkHeap();
    }
  }

  step(): PreviewSnapshot {
    if (terminal(this.#status)) return this.getSnapshot();
    this.#status = "paused";
    this.#sliceWork = 0;
    try {
      let thread = this.nextThread();
      if (!thread && this.#threads.length && !this.#externalClock) {
        const nextWake = Math.min(...this.#threads.map((item) => item.wakeAt));
        this.advance(Math.max(0, nextWake - this.#elapsedMs));
        thread = this.nextThread();
      }
      if (thread) {
        this.execute(thread);
        this.checkHeap();
      }
    } catch (error) {
      this.fail(error);
    }
    return this.getSnapshot();
  }

  getSnapshot(): PreviewSnapshot {
    let budget = PREVIEW_LIMITS.snapshotValues as number;
    let omittedVariableCount = 0;
    const truncatedVariables: string[] = [];
    const values = (cells: Map<string, Cell>, scope: string): Record<string, PreviewValue> => {
      const entries: Array<[string, PreviewValue]> = [];
      for (const cell of cells.values()) {
        if (cell.name.startsWith("$")) continue;
        if (entries.length >= PREVIEW_LIMITS.snapshotVariablesPerScope || budget <= 0) {
          omittedVariableCount++;
          continue;
        }
        if (Array.isArray(cell.value)) {
          const length = Math.min(cell.value.length, budget, PREVIEW_LIMITS.snapshotArrayElements);
          entries.push([cell.name, cell.value.slice(0, length)]);
          budget -= Math.max(1, length);
          if (length < cell.value.length) truncatedVariables.push(`${scope}.${cell.name}`);
        } else {
          entries.push([cell.name, cell.value]);
          budget--;
        }
      }
      return Object.fromEntries(entries);
    };
    const stack = this.#currentThread?.stack ?? [];
    const globals = values(this.#globals, "global");
    const locals = stack.length ? values(stack.at(-1)!.cells, "local") : {};
    return {
      status: this.#status,
      device: this.#device.snapshot(),
      globals,
      locals,
      ...(this.#currentSpan ? { currentSpan: this.#currentSpan } : {}),
      callStack: stack.map((frame) => frame.fn.name),
      instructions: this.#instructions,
      elapsedMs: this.#elapsedMs,
      threadCount: this.#threads.length,
      truncatedVariables,
      omittedVariableCount,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  private advance(delta: number): void {
    this.#elapsedMs += delta;
    this.#device.advance(delta);
  }

  private nextThread(): Thread | undefined {
    if (!this.#threads.length) {
      this.finish("completed");
      return;
    }
    for (let count = 0; count < this.#threads.length; count++) {
      this.#cursor %= this.#threads.length;
      const thread = this.#threads[this.#cursor++]!;
      if (thread.rootPending && this.functionActive(thread.root, thread)) continue;
      thread.rootPending = false;
      if (thread.waitingForFunction && this.functionActive(thread.waitingForFunction, thread))
        continue;
      if (
        thread.waitingForMutex !== undefined &&
        this.#mutexes.get(thread.waitingForMutex) !== null
      )
        continue;
      delete thread.waitingForFunction;
      delete thread.waitingForMutex;
      if (thread.wakeAt <= this.#elapsedMs) return thread;
    }
    return undefined;
  }

  private functionFor(name: string): IRFunction {
    const fn = this.#functions.get(key(name));
    if (!fn) throw new Error(`Unknown function '${name}'.`);
    return fn;
  }

  private functionActive(name: string, caller: Thread): boolean {
    return this.#threads.some(
      (thread) =>
        thread !== caller &&
        !thread.rootPending &&
        thread.stack.some((frame) => key(frame.fn.name) === key(name)),
    );
  }

  private checkHeap(): void {
    if (!this.#heapDirty) return;
    this.#heapDirty = false;
    const arrays = new Set<PreviewValue[]>(this.#rows.values());
    let variables = 0;
    const collect = (cells: Map<string, Cell>) => {
      variables += cells.size;
      this.#sliceWork += cells.size;
      if (variables > PREVIEW_LIMITS.liveVariables)
        throw new Error("Preview live variable limit exceeded.");
      for (const cell of cells.values()) if (Array.isArray(cell.value)) arrays.add(cell.value);
    };
    collect(this.#globals);
    for (const thread of this.#threads) for (const frame of thread.stack) collect(frame.cells);
    let size = 0;
    for (const array of arrays) {
      // String slots reserve 252 bytes in the EV3 backend; charge that here too.
      size += array.length * (this.#stringArrays.has(array) ? 32 : 1);
      if (size > PREVIEW_LIMITS.liveArrayElements)
        throw new Error("Preview live array memory limit exceeded.");
    }
  }

  private defaultValue(type: IRType): PreviewValue {
    if (type.kind === "array") {
      this.#heapDirty = true;
      const result: PreviewValue[] = Array.from(
        { length: type.element === "string" ? 2 : 8 },
        () => (type.element === "string" ? "" : 0),
      );
      if (type.element === "string") this.#stringArrays.add(result);
      return result;
    }
    return type.kind === "string" ? "" : type.kind === "boolean" ? false : 0;
  }

  private newCell(variable: IRVariable): Cell {
    return { type: variable.type, name: variable.name, value: this.defaultValue(variable.type) };
  }

  private frame(fn: IRFunction): Frame {
    this.#heapDirty = true;
    if (fn.locals.length + fn.parameters.length > 4096)
      throw new Error("Too many local variables for offline preview.");
    const block = fn.blocks.find((candidate) => candidate.id === fn.entryBlock);
    if (!block) throw new Error(`Missing entry block in '${fn.name}'.`);
    return {
      fn,
      cells: new Map(
        [...fn.locals, ...fn.parameters].map((variable) => [
          key(variable.name),
          this.newCell(variable),
        ]),
      ),
      block,
      index: 0,
      outputs: [],
    };
  }

  private cell(frame: Frame, name: string): Cell {
    const cell = frame.cells.get(key(name)) ?? this.#globals.get(key(name));
    if (!cell) throw new Error(`Unknown variable '${name}'.`);
    return cell;
  }

  private value(frame: Frame, value: IRValue): PreviewValue {
    if (value.kind === "variable") return this.cell(frame, value.name).value;
    return this.convert({ kind: value.kind }, value.value);
  }

  private type(frame: Frame, value: IRValue): IRType {
    return value.kind === "variable" ? this.cell(frame, value.name).type : { kind: value.kind };
  }

  private convert(type: IRType, value: PreviewValue): PreviewValue {
    switch (type.kind) {
      case "string":
        return checkedText(previewText(value));
      case "number":
        return Math.fround(numeric(value));
      case "integer":
        return Math.trunc(numeric(value)) | 0;
      case "boolean":
        return typeof value === "boolean" ? value : numeric(value) !== 0;
      case "array": {
        this.#heapDirty = true;
        if (!Array.isArray(value)) throw new Error("Expected an array value.");
        this.checkSize(value.length);
        if (type.element === "string") this.#stringArrays.add(value);
        return value;
      }
      case "void":
        return 0;
    }
  }

  private write(cell: Cell, value: PreviewValue): void {
    cell.value = this.convert(cell.type, value);
  }

  private execute(thread: Thread): void {
    this.#sliceWork++;
    this.#currentThread = thread;
    const frame = thread.stack.at(-1)!;
    const instruction = frame.block.instructions[frame.index];
    this.#currentSpan =
      instruction?.span ?? frame.block.terminator.span ?? frame.block.span ?? frame.fn.span;
    if (++this.#instructions > this.#sessionInstructionLimit)
      throw new Error(
        `Preview reached its ${this.#sessionInstructionLimit.toLocaleString("en-US")}-instruction limit. Stop and restart to continue.`,
      );
    if (!instruction) {
      const terminator = frame.block.terminator;
      if (terminator.op === "jump" || terminator.op === "branch") {
        const target =
          terminator.op === "jump"
            ? terminator.target
            : this.value(frame, terminator.condition)
              ? terminator.whenTrue
              : terminator.whenFalse;
        const block = frame.fn.blocks.find((candidate) => candidate.id === target);
        if (!block) throw new Error(`Missing block '${target}'.`);
        frame.block = block;
        frame.index = 0;
      } else
        this.returnFrom(
          thread,
          frame,
          terminator.op === "return" && terminator.value
            ? this.value(frame, terminator.value)
            : this.defaultValue(frame.fn.returnType),
        );
      return;
    }
    switch (instruction.op) {
      case "assign":
        this.write(this.cell(frame, instruction.target), this.value(frame, instruction.value));
        break;
      case "unary":
        this.write(
          this.cell(frame, instruction.target),
          instruction.operator === "not"
            ? !this.value(frame, instruction.value)
            : -numeric(this.value(frame, instruction.value)),
        );
        break;
      case "binary":
        this.write(this.cell(frame, instruction.target), this.binary(frame, instruction));
        break;
      case "call": {
        const fn = this.functionFor(instruction.functionName);
        // EV3 SUBCALL objects are non-reentrant across threads. A contended
        // call waits while other runnable threads continue to make progress.
        if (this.functionActive(fn.name, thread)) {
          thread.waitingForFunction = fn.name;
          return;
        }
        if (thread.stack.length >= PREVIEW_LIMITS.callDepth)
          throw new Error("Preview call stack exceeds 64 frames.");
        const callee = this.frame(fn);
        fn.parameters.forEach((parameter, index) => {
          const argument = instruction.args[index];
          if (!argument) throw new Error(`Missing argument '${parameter.name}'.`);
          if (parameter.direction === "out") {
            if (argument.kind !== "variable")
              throw new Error("Output arguments must be variables.");
            callee.outputs.push({
              parameter: parameter.name,
              caller: this.cell(frame, argument.name),
            });
          } else this.write(this.cell(callee, parameter.name), this.value(frame, argument));
        });
        if (instruction.target) callee.target = this.cell(frame, instruction.target);
        frame.index++;
        thread.stack.push(callee);
        return;
      }
      case "thread-start": {
        const name = key(instruction.functionName);
        if (!this.#threads.some((item) => item.root === name)) {
          if (this.#threads.length >= PREVIEW_LIMITS.threads)
            throw new Error("Preview supports at most 16 active threads.");
          const fn = this.functionFor(name);
          if (fn.parameters.length)
            throw new Error("Thread entry functions cannot have parameters.");
          this.#threads.push({
            id: this.#nextThread++,
            root: name,
            stack: [this.frame(fn)],
            wakeAt: this.#elapsedMs,
            rootPending: true,
          });
        }
        break;
      }
      case "ev3-call": {
        const args = instruction.args.map((argument) => this.value(frame, argument));
        const result = this.invoke(
          instruction.operation,
          args,
          thread,
          this.#callsites.get(instruction),
        );
        if (result.end) {
          this.finish("completed");
          return;
        }
        if (result.writes)
          for (const [index, value] of Object.entries(result.writes)) {
            const argument = instruction.args[Number(index)];
            if (argument?.kind !== "variable")
              throw new Error("Output arguments must be variables.");
            this.write(this.cell(frame, argument.name), value);
          }
        if (instruction.target && result.value !== undefined)
          this.write(this.cell(frame, instruction.target), result.value);
        if (result.waitMs !== undefined || result.retry) {
          const wait = result.waitMs ?? 16;
          if (!Number.isFinite(wait) || wait < 0)
            throw new Error("Invalid virtual device wait duration.");
          thread.wakeAt = this.#elapsedMs + wait;
        }
        if (result.retry) return;
        break;
      }
    }
    frame.index++;
  }

  private returnFrom(thread: Thread, frame: Frame, value: PreviewValue): void {
    for (const output of frame.outputs)
      this.write(output.caller, this.cell(frame, output.parameter).value);
    if (frame.target) this.write(frame.target, this.convert(frame.fn.returnType, value));
    thread.stack.pop();
    if (!thread.stack.length) {
      this.#threads.splice(this.#threads.indexOf(thread), 1);
      if (!this.#threads.length) this.finish("completed");
    }
  }

  private binary(
    frame: Frame,
    instruction: Extract<IRInstruction, { op: "binary" }>,
  ): PreviewValue {
    const left = this.value(frame, instruction.left),
      right = this.value(frame, instruction.right);
    if (instruction.operator === "+" && this.cell(frame, instruction.target).type.kind === "string")
      return checkedText(previewText(left) + previewText(right));
    if (instruction.operator === "and") return Boolean(left) && Boolean(right);
    if (instruction.operator === "or") return Boolean(left) || Boolean(right);
    if (
      (typeof left === "string" && (typeof right === "string" || typeof right === "boolean")) ||
      (typeof right === "string" && typeof left === "boolean")
    ) {
      // Legacy Basic Plus programs mix textual flags ("True"/"False") with Boolean literals.
      // Keep ordinary text comparison case-sensitive and use the existing Boolean text form.
      if (instruction.operator === "=") return previewText(left) === previewText(right);
      if (instruction.operator === "<>") return previewText(left) !== previewText(right);
      throw new Error(`Text operator '${instruction.operator}' is unavailable in offline preview.`);
    }
    const integer =
      this.cell(frame, instruction.target).type.kind !== "number" &&
      this.type(frame, instruction.left).kind === "integer" &&
      this.type(frame, instruction.right).kind === "integer";
    const a = integer ? numeric(left) : Math.fround(numeric(left));
    const b = integer ? numeric(right) : Math.fround(numeric(right));
    switch (instruction.operator) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return integer ? Math.imul(a, b) : a * b;
      case "/":
        if (integer && b === 0) throw new Error("Integer division by zero.");
        return integer ? Math.trunc(a / b) : a / b;
      case "%":
        if (integer && b === 0) throw new Error("Integer remainder by zero.");
        return a % b;
      case "=":
        return a === b;
      case "<>":
        return a !== b;
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
    }
  }

  private invoke(
    operation: string,
    args: PreviewValue[],
    thread: Thread,
    context?: PreviewInvokeContext,
  ): DeviceResult {
    const name = key(operation);
    const scalar = scalarOperation(operation, args, () => {
      let state = this.#randomState;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      this.#randomState = state >>> 0;
      return this.#randomState / 0x1_0000_0000;
    });
    if (scalar !== undefined) return { value: scalar };
    if (name.startsWith("assert.")) {
      const [left, right] = args;
      let passed = false;
      switch (name) {
        case "assert.equal":
          passed = left === right;
          break;
        case "assert.notequal":
          passed = left !== right;
          break;
        case "assert.less":
          passed = numeric(left) < numeric(right);
          break;
        case "assert.greater":
          passed = numeric(left) > numeric(right);
          break;
        case "assert.lessequal":
          passed = numeric(left) <= numeric(right);
          break;
        case "assert.greaterequal":
          passed = numeric(left) >= numeric(right);
          break;
        case "assert.near":
          passed = Math.abs(Math.fround(numeric(left) - numeric(right))) <= Math.fround(0.0001);
          break;
        case "assert.failed":
          break;
        default:
          throw new Error(`Unsupported operation '${operation}'.`);
      }
      if (!passed)
        throw new Error(`Assertion failed: ${previewText(args[name === "assert.failed" ? 0 : 2])}`);
      return {};
    }
    if (name.startsWith("row.") || name.startsWith("vector."))
      return { value: this.arrayOperation(name, args) };
    if (name === "thread.yield") return {};
    if (name === "thread.createmutex") {
      if (this.#mutexes.size >= 256) throw new Error("Preview mutex limit exceeded.");
      const handle = this.#mutexes.size;
      this.#mutexes.set(handle, null);
      return { value: handle };
    }
    if (name === "thread.lock" || name === "thread.unlock") {
      const handle = Math.trunc(numeric(args[0]));
      if (!this.#mutexes.has(handle)) throw new Error(`Unknown mutex '${handle}'.`);
      if (name === "thread.unlock") {
        this.#mutexes.set(handle, null);
        return {};
      }
      if (this.#mutexes.get(handle) !== null) {
        thread.waitingForMutex = handle;
        return { retry: true, waitMs: 0 };
      }
      this.#mutexes.set(handle, thread.id);
      return {};
    }
    const signature = getEV3Operation(operation);
    // Device raster operations are bounded to the LCD. Account for their
    // work as well as the single IR call so a drawing loop remains stoppable.
    if (signature?.category === "display") this.#sliceWork += 178 * 128;
    const converted = args.map((value, index) => {
      const expected = signature?.parameters[index];
      const accepted = Array.isArray(expected) ? expected : [expected];
      return operation !== "Sensor.ReadSIValue" &&
        accepted.includes("integer") &&
        !accepted.includes("number") &&
        typeof value === "number"
        ? Math.trunc(value) | 0
        : value;
    });
    const result = this.#device.invoke(operation, converted, this.#elapsedMs, context);
    if (Array.isArray(result.value)) this.#sliceWork += result.value.length;
    return result;
  }

  private checkSize(size: number): number {
    if (!Number.isInteger(size) || size < 0 || size > PREVIEW_LIMITS.arrayElements)
      throw new Error(`Array size must be between 0 and ${PREVIEW_LIMITS.arrayElements}.`);
    return size;
  }

  private array(value: PreviewValue | undefined): PreviewValue[] {
    const array = Array.isArray(value)
      ? value
      : typeof value === "number"
        ? this.#rows.get(value)
        : undefined;
    if (!array || this.#deletedArrays.has(array))
      throw new Error("Invalid or deleted array handle.");
    return array;
  }

  private arrayRead(array: PreviewValue[], index: number): PreviewValue {
    if (!Number.isInteger(index) || index < 0 || index >= array.length)
      throw new Error(`Array index ${index} is outside 0…${array.length - 1}.`);
    return array[index]!;
  }

  private arrayOperation(name: string, args: PreviewValue[]): PreviewValue {
    if (name !== "row.read" && name !== "row.size") this.#heapDirty = true;
    const n = (index: number) => Math.trunc(numeric(args[index]));
    if (name === "row.init" || name === "vector.init") {
      const size = this.checkSize(n(0));
      this.#sliceWork += size;
      const result = Array<PreviewValue>(size).fill(Math.fround(numeric(args[1])));
      if (name === "vector.init") return result;
      if (this.#rows.size >= PREVIEW_LIMITS.rowHandles)
        throw new Error("Preview Row handle limit exceeded. Use Row.Delete when finished.");
      const handle = this.#nextRow++;
      this.#rows.set(handle, result);
      return handle;
    }
    if (name.startsWith("row.")) {
      const array = this.array(args[0]);
      const stringArray = this.#stringArrays.has(array);
      switch (name) {
        case "row.delete":
          this.#deletedArrays.add(array);
          if (typeof args[0] === "number") this.#rows.delete(args[0]);
          return 0;
        case "row.size":
          return array.length * (stringArray ? 252 : 1);
        case "row.read":
          return this.arrayRead(array, n(1));
        case "row.write": {
          const index = n(1);
          if (stringArray && index >= array.length) {
            this.checkSize(index + 1);
            this.#sliceWork += index + 1 - array.length;
            while (array.length <= index) array.push("");
          }
          this.arrayRead(array, index);
          array[index] = stringArray
            ? checkedText(previewText(args[2]))
            : Math.fround(numeric(args[2]));
          return 0;
        }
        case "row.resize": {
          const length = this.checkSize(n(1));
          if (stringArray && length % 252 !== 0)
            throw new Error("String-array Row.Resize requires a byte count divisible by 252.");
          const elements = stringArray ? length / 252 : length;
          this.#sliceWork += Math.max(0, elements - array.length);
          while (array.length < elements) array.push(stringArray ? "" : 0);
          array.length = elements;
          return 0;
        }
      }
    }
    const count = this.checkSize(n(0));
    this.#sliceWork += count;
    if (name === "vector.data") {
      const tokens = previewText(args[1]).split(" ").filter(Boolean);
      return Array.from({ length: count }, (_, index) =>
        tokens[index] === undefined ? 0 : Math.fround(Number.parseFloat(tokens[index])),
      );
    }
    if (name === "vector.add") {
      const a = this.array(args[1]),
        b = this.array(args[2]);
      return Array.from({ length: count }, (_, index) =>
        Math.fround(numeric(this.arrayRead(a, index)) + numeric(this.arrayRead(b, index))),
      );
    }
    if (name === "vector.sort") {
      this.#sliceWork += count * Math.ceil(Math.log2(Math.max(1, count)));
      const array = this.array(args[1]);
      if (count > array.length) this.arrayRead(array, count - 1);
      return array.slice(0, count).sort((a, b) => numeric(a) - numeric(b));
    }
    if (name === "vector.multiply") {
      const columns = this.checkSize(n(1)),
        inner = this.checkSize(n(2));
      this.checkSize(count * columns);
      if (count * columns * inner > PREVIEW_LIMITS.vectorOperations)
        throw new Error("Matrix multiplication exceeds the preview operation limit.");
      this.#sliceWork += count * columns * inner;
      const a = this.array(args[3]),
        b = this.array(args[4]);
      return Array.from({ length: count * columns }, (_, index) => {
        const row = Math.floor(index / columns),
          column = index % columns;
        let value = 0;
        for (let k = 0; k < inner; k++)
          value = Math.fround(
            value +
              Math.fround(
                numeric(this.arrayRead(a, row * inner + k)) *
                  numeric(this.arrayRead(b, k * columns + column)),
              ),
          );
        return value;
      });
    }
    throw new Error(`Unsupported operation '${name}'.`);
  }

  private finish(status: "completed" | "stopped" | "error"): void {
    if (terminal(this.#status)) return;
    this.#status = status;
    this.#threads.length = 0;
    this.#device.invoke("Motor.Stop", ["ABCD", true], this.#elapsedMs);
    this.#device.invoke("Speaker.Stop", [], this.#elapsedMs);
  }

  private fail(error: unknown): void {
    this.#error = {
      message: error instanceof Error ? error.message : String(error),
      ...(this.#currentSpan ? { span: this.#currentSpan } : {}),
    };
    this.finish("error");
  }
}
