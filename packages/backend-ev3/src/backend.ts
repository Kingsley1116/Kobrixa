import type { BackendResult, CompilerBackend, Diagnostic } from "@kobrixa/compiler";
import { getEV3Operation } from "@kobrixa/ir";
import type {
  IRBasicBlock,
  IRFunction,
  IRInstruction,
  IRType,
  IRVariable,
  IRValue,
  KobrixaIR,
  SourceSpan,
} from "@kobrixa/ir";
import { gh, gv, lc, lcf, lcs, lh, lv, relativeOffset } from "./encoding.js";
import {
  ARRAY,
  COM_GET,
  FILE,
  FILENAME,
  INPUT_DEVICE,
  MATH,
  OP,
  SOUND,
  STRING,
  UI_BUTTON,
  UI_DRAW,
  UI_READ,
  UI_WRITE,
} from "./opcodes.js";
import { createRbf, inspectRbf, type RbfObject } from "./rbf.js";

import { expandRecursiveCalls } from "./recursion.js";
import { hasCallLocalArrays } from "./array-lifetime.js";
import { patchJumps, type JumpPatch, type Label } from "./jumps.js";
import { eliminateCopies, reachableFunctions, temporaryInterference } from "./optimization.js";

const OBJECT_EPILOGUE = Symbol("object-epilogue");

interface Allocation {
  offset: number;
  type: IRType;
  scope: "global" | "local";
}

interface CallableFunction {
  fn: IRFunction;
  objectId: number;
}

/** CLEV3R's standard string value capacity, including its terminating NUL. */
const STRING_BYTES = 252;

function diagnostic(code: string, message: string, span?: SourceSpan): Diagnostic {
  return {
    code,
    severity: "error",
    file: span?.file ?? "<generated>",
    range: span
      ? {
          startLine: span.start.line,
          startColumn: span.start.column,
          endLine: span.end.line,
          endColumn: span.end.column,
        }
      : { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    message,
  };
}

function sizeOf(type: IRType): number {
  if (type.kind === "boolean") return 1;
  if (type.kind === "string") return STRING_BYTES;
  if (type.kind === "array") return 4;
  return type.kind === "void" ? 0 : 4;
}

function callParameterSize(type: IRType): number {
  if (type.kind === "string") return STRING_BYTES;
  return sizeOf(type);
}

function callParameterCode(variable: Pick<IRVariable, "type" | "direction">): number[] {
  const direction = variable.direction === "out" ? 0x40 : 0x80;
  if (variable.type.kind === "string") return [direction | 0x04, STRING_BYTES];
  // Handles live in DATA32 slots throughout the IR backend. Passing two-byte
  // handles would pack adjacent array parameters differently from that layout.
  if (variable.type.kind === "array") return [direction | 0x02];
  if (variable.type.kind === "boolean") return [direction];
  return [direction | (variable.type.kind === "integer" ? 0x02 : 0x03)];
}

function orderedParameters(fn: IRFunction): IRVariable[] {
  return [...fn.parameters]
    .map((variable, index) => ({ variable, index }))
    .sort(
      (left, right) =>
        callParameterSize(right.variable.type) - callParameterSize(left.variable.type) ||
        left.index - right.index,
    )
    .map(({ variable }) => variable);
}

function motorMask(value: IRValue): number | undefined {
  if (value.kind !== "string") return undefined;
  let mask = 0;
  for (const char of value.value.toLocaleUpperCase("en-US")) {
    const index = "ABCD".indexOf(char);
    if (index < 0) return undefined;
    mask |= 1 << index;
  }
  return mask || undefined;
}

function ledPattern(color: IRValue, effect: IRValue): number | undefined {
  if (color.kind !== "string" || effect.kind !== "string") return undefined;
  const base: Record<string, number> = { OFF: 0, GREEN: 1, RED: 2, ORANGE: 3 };
  const value = base[color.value.toLocaleUpperCase("en-US")];
  if (value === undefined) return undefined;
  const normalized = effect.value.toLocaleUpperCase("en-US");
  if (normalized === "NORMAL") return value;
  if (value === 0) return normalized === "NORMAL" ? 0 : undefined;
  if (normalized === "FLASH") return value + 3;
  if (normalized === "PULSE") return value + 6;
  return undefined;
}

function buttonCode(value: IRValue): number | undefined {
  if (value.kind !== "string") return undefined;
  const name = value.value.toLocaleUpperCase("en-US");
  const buttons: Record<string, number> = {
    U: 1,
    UP: 1,
    E: 2,
    ENTER: 2,
    CENTER: 2,
    D: 3,
    DOWN: 3,
    R: 4,
    RIGHT: 4,
    L: 5,
    LEFT: 5,
    B: 6,
    BACK: 6,
    ANY: 7,
  };
  return buttons[name];
}

class ObjectAssembler {
  readonly bytes: number[] = [];
  readonly labels = new Map<Label, number>();
  readonly patches: JumpPatch[] = [];
  readonly allocations = new Map<string, Allocation>();
  readonly diagnostics: Diagnostic[] = [];
  localBytes = 0;
  private scratchOffset = 0;
  private scratchBase = 0;
  readonly callLocalArrayHandles: number[] = [];
  readonly reclaimLocalArrays: boolean;

  get isBackgroundThread(): boolean {
    return this.threadObjects.has(this.fn.name.toLocaleLowerCase("en-US"));
  }

  constructor(
    readonly fn: IRFunction,
    readonly objectId: number,
    readonly callables: ReadonlyMap<string, CallableFunction>,
    readonly hasMutexes: boolean,
    readonly hasLcdUpdateControl: boolean,
    readonly mailboxAllocator: { next: number },
    readonly globalAllocations: ReadonlyMap<string, Allocation>,
    readonly threadObjects: ReadonlyMap<string, number>,
    readonly mutexObjectId: number,
    readonly timerBaselines: number | undefined,
    readonly optimize: boolean,
    signal: AbortSignal,
    readonly runtimeDirectory?: string,
  ) {
    this.reclaimLocalArrays = hasCallLocalArrays(fn);
    const parameters = orderedParameters(fn);
    const variables =
      fn.returnType.kind === "void"
        ? [...parameters, ...fn.locals]
        : [
            ...parameters,
            {
              name: "$return",
              type: fn.returnType,
              scope: "parameter" as const,
              direction: "out" as const,
            },
            ...fn.locals,
          ];
    const interference = optimize
      ? temporaryInterference(
          fn,
          new Map([...callables].map(([name, { fn }]) => [name, fn])),
          signal,
        )
      : new Map<string, ReadonlySet<string>>();
    const reusableSlots: Array<{ offset: number; kind: IRType["kind"]; names: string[] }> = [];
    for (const variable of variables) {
      const name = variable.name.toLocaleLowerCase("en-US");
      const conflicts = interference.get(name);
      const slot =
        conflicts &&
        reusableSlots.find(
          (candidate) =>
            candidate.kind === variable.type.kind &&
            candidate.names.every((other) => !conflicts.has(other)),
        );
      if (slot) {
        this.allocations.set(name, { offset: slot.offset, type: variable.type, scope: "local" });
        slot.names.push(name);
        continue;
      }
      const alignment = sizeOf(variable.type) >= 4 ? 4 : 1;
      this.localBytes = Math.ceil(this.localBytes / alignment) * alignment;
      this.allocations.set(name, {
        offset: this.localBytes,
        type: variable.type,
        scope: "local",
      });
      if (conflicts)
        reusableSlots.push({ offset: this.localBytes, kind: variable.type.kind, names: [name] });
      this.localBytes += sizeOf(variable.type);
    }
    this.scratchOffset = this.scratchBase = this.localBytes;
  }

  assemble(signal: AbortSignal): Uint8Array {
    if (this.fn.name !== "main") {
      const parameters = orderedParameters(this.fn);
      if (this.fn.returnType.kind !== "void")
        parameters.push({
          name: "$return",
          type: this.fn.returnType,
          scope: "parameter",
          direction: "out",
        });
      this.bytes.push(...lc(parameters.length));
      for (const parameter of parameters) this.bytes.push(...callParameterCode(parameter));
    }
    if (this.fn.name === "main") {
      if (this.hasMutexes) this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_8), ...lc(0), ...gv(0));
      if (this.hasLcdUpdateControl) this.bytes.push(OP.MOVE_32_32, ...lc(0), ...gv(4));
    }
    this.initializeArrays();
    for (const [index, block] of this.fn.blocks.entries()) {
      signal.throwIfAborted();
      this.labels.set(block.id, this.bytes.length);
      for (const instruction of block.instructions) {
        if (this.optimize) this.scratchOffset = this.scratchBase;
        this.instruction(instruction);
      }
      if (this.optimize) this.scratchOffset = this.scratchBase;
      this.terminator(block, this.fn.blocks[index + 1]?.id ?? OBJECT_EPILOGUE);
    }
    this.labels.set(OBJECT_EPILOGUE, this.bytes.length);
    for (const handle of this.callLocalArrayHandles)
      this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(handle));
    if (this.fn.name === "main") this.bytes.push(OP.OBJECT_END);
    else this.bytes.push(OP.RETURN, OP.OBJECT_END);
    for (const patch of this.patches) {
      const target = this.labels.get(patch.target);
      if (target === undefined) {
        this.diagnostics.push(
          diagnostic("EV31003", `Unknown bytecode label '${String(patch.target)}'.`),
        );
        continue;
      }
    }
    if (this.diagnostics.length) return Uint8Array.from(this.bytes);
    return patchJumps(this.bytes, this.labels, this.patches, this.optimize, signal);
  }

  private parameter(value: IRValue): number[] | undefined {
    if (value.kind === "number") return lcf(value.value);
    if (value.kind === "integer") return lc(value.value);
    if (value.kind === "boolean") return lc(value.value ? 1 : 0);
    if (value.kind === "string") return lcs(value.value);
    const allocation = this.allocationFor(value.name);
    if (!allocation) return undefined;
    return this.location(allocation);
  }

  private allocationFor(name: string): Allocation | undefined {
    const key = name.toLocaleLowerCase("en-US");
    return this.allocations.get(key) ?? this.globalAllocations.get(key);
  }

  private location(allocation: Allocation, byteOffset = 0): number[] {
    return allocation.scope === "global"
      ? gv(allocation.offset + byteOffset)
      : lv(allocation.offset + byteOffset);
  }

  private arrayContents(value: IRValue): number[] | undefined {
    if (value.kind !== "variable") return undefined;
    const allocation = this.allocationFor(value.name);
    return allocation
      ? allocation.scope === "global"
        ? gh(allocation.offset)
        : lh(allocation.offset)
      : undefined;
  }

  private initializeArrays(): void {
    const arrays = [
      ...this.allocations.values(),
      ...(this.fn.name === "main" ? this.globalAllocations.values() : []),
    ].filter((allocation) => allocation.type.kind === "array");
    for (const allocation of arrays) {
      // Input array parameters already contain the caller's handle. Replacing
      // it here loses the supplied elements and silently disconnects writes.
      if (
        this.fn.parameters.some(
          (parameter) =>
            parameter.direction !== "out" && this.allocationFor(parameter.name) === allocation,
        )
      )
        continue;
      const type = allocation.type;
      if (type.kind !== "array") continue;
      if (type.element === "string") {
        this.bytes.push(
          OP.ARRAY,
          ...lc(ARRAY.CREATE_8),
          ...lc(STRING_BYTES * 2),
          ...this.location(allocation),
        );
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.FILL), ...this.location(allocation), ...lc(0));
      } else {
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...lc(8), ...this.location(allocation));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.FILL), ...this.location(allocation), ...lcf(0));
      }
      this.retainCallLocalArray(this.location(allocation), allocation);
    }
  }

  private retainCallLocalArray(handle: number[], allocation: Allocation): void {
    if (
      !this.reclaimLocalArrays ||
      !this.fn.locals.some(
        (local) => local.type.kind === "array" && this.allocationFor(local.name) === allocation,
      )
    )
      return;
    // Save the allocation itself: local aliases can subsequently be overwritten.
    const saved = this.scratch(4);
    this.bytes.push(OP.MOVE_16_32, ...handle, ...lv(saved));
    this.callLocalArrayHandles.push(saved);
    // Cleanup reads this handle in the epilogue. Pin the region through this
    // slot so instruction-scoped scratch reuse cannot overwrite it.
    this.scratchBase = this.scratchOffset;
  }

  private stringArrayIndex(index: IRValue): number[] | undefined {
    const integer = this.integerParameter(index);
    if (!integer) return undefined;
    const byteIndex = this.scratch(4);
    this.bytes.push(OP.MUL_32, ...integer, ...lc(STRING_BYTES), ...lv(byteIndex));
    return lv(byteIndex);
  }

  private fixedStringSource(value: IRValue): number[] | undefined {
    const source = this.parameter(value);
    if (!source) return undefined;
    if (value.kind === "variable") return source;
    const scratch = this.scratch(STRING_BYTES);
    this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...source, ...lv(scratch));
    return lv(scratch);
  }

  /** CLEV3R automatically converts a number to text when an API expects text. */
  private textParameter(value: IRValue): number[] | undefined {
    const type = this.typeOf(value)?.kind;
    if (type === "string") return this.parameter(value);
    if (value.kind === "boolean") return lcs(value.value ? "True" : "False");
    if (type === "boolean") {
      const source = this.parameter(value);
      if (!source) return undefined;
      const target = this.scratch(STRING_BYTES);
      const whenFalse = this.newLabel("boolean-text-false");
      const done = this.newLabel("boolean-text-done");
      this.bytes.push(OP.JR_FALSE, ...source);
      this.addPatch(whenFalse);
      this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...lcs("True"), ...lv(target));
      this.bytes.push(OP.JR);
      this.addPatch(done);
      this.markLabel(whenFalse);
      this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...lcs("False"), ...lv(target));
      this.markLabel(done);
      return lv(target);
    }
    if (type !== "number" && type !== "integer") return undefined;
    const number = this.floatParameter(value);
    if (!number) return undefined;
    const target = this.scratch(STRING_BYTES);
    this.bytes.push(
      OP.STRING,
      ...lc(STRING.VALUE_FORMATTED),
      ...number,
      ...lcs("%g"),
      ...lc(99),
      ...lv(target),
    );
    return lv(target);
  }

  private readStringArray(handle: number[], index: IRValue, target: Allocation): void {
    const byteIndex = this.stringArrayIndex(index);
    if (!byteIndex) return;
    this.bytes.push(OP.MOVE_8_8, ...lc(0), ...this.location(target));
    this.bytes.push(
      OP.ARRAY,
      ...lc(ARRAY.READ_CONTENT),
      ...lc(1),
      ...handle,
      ...byteIndex,
      ...lc(STRING_BYTES),
      ...this.location(target),
    );
  }

  private writeStringArray(handle: number[], index: IRValue, value: IRValue): void {
    const byteIndex = this.stringArrayIndex(index);
    const source = this.fixedStringSource(value);
    if (!byteIndex || !source) return;
    this.bytes.push(
      OP.ARRAY,
      ...lc(ARRAY.WRITE_CONTENT),
      ...lc(1),
      ...handle,
      ...byteIndex,
      ...lc(STRING_BYTES),
      ...source,
    );
  }

  private floatParameter(value: IRValue): number[] | undefined {
    if (value.kind === "number" || value.kind === "integer") return lcf(value.value);
    const parameter = this.parameter(value);
    if (!parameter) return undefined;
    if (this.typeOf(value)?.kind !== "integer") return parameter;
    const scratch = this.scratch(4);
    this.bytes.push(OP.MOVE_32_F, ...parameter, ...lv(scratch));
    return lv(scratch);
  }

  private integerParameter(value: IRValue): number[] | undefined {
    const parameter = this.parameter(value);
    if (!parameter) return undefined;
    if (this.typeOf(value)?.kind !== "number") return parameter;
    const scratch = this.scratch(4);
    this.bytes.push(OP.MOVE_F_32, ...parameter, ...lv(scratch));
    return lv(scratch);
  }

  private motorPercentage(value: IRValue): number[] | undefined {
    if (value.kind === "number" || value.kind === "integer")
      return lc(Math.trunc(Math.max(-100, Math.min(100, value.value))));
    const source = this.integerParameter(value);
    if (!source) return undefined;
    // OUTPUT_* reads a signed DATA8, not DATA32. Merely pointing it at an
    // integer wraps e.g. -160 to +96, reversing the requested direction.
    const bounded = this.scratch(4);
    const outside = this.scratch(1);
    const upper = this.newLabel("motor-upper-limit");
    const done = this.newLabel("motor-percentage-ready");
    this.bytes.push(OP.MOVE_32_32, ...source, ...lv(bounded));
    this.bytes.push(OP.CP_LT_32, ...lv(bounded), ...lc(-100), ...lv(outside));
    this.bytes.push(OP.JR_FALSE, ...lv(outside));
    this.addPatch(upper);
    this.bytes.push(OP.MOVE_32_32, ...lc(-100), ...lv(bounded));
    this.markLabel(upper);
    this.bytes.push(OP.CP_GT_32, ...lv(bounded), ...lc(100), ...lv(outside));
    this.bytes.push(OP.JR_FALSE, ...lv(outside));
    this.addPatch(done);
    this.bytes.push(OP.MOVE_32_32, ...lc(100), ...lv(bounded));
    this.markLabel(done);
    return lv(bounded);
  }

  private byteParameter(value: IRValue): number[] | undefined {
    // Byte APIs retain the low eight bits. EV3 MOVE32_8 / MOVEF_8 saturate,
    // so take the raw low byte of a DATA32 instead of narrowing numerically.
    // Materialize high-bit constants before MOVE8_8: the stock VM rejects
    // narrowing literal values and reserves -128 as the DATA8 NaN sentinel.
    if (value.kind === "integer") {
      const byte = value.value & 255;
      if (byte < 128) return lc(byte);
      const scratch = this.scratch(4);
      this.bytes.push(OP.MOVE_32_32, ...lc(byte), ...lv(scratch));
      return lv(scratch);
    }
    return this.integerParameter(value);
  }

  private unsignedByte(source: number[], destination: number[]): void {
    // MOVE8_32 sign-extends, including the -128 NaN sentinel. Zero-fill a
    // DATA32 and copy its low byte to represent the entire unsigned range.
    this.bytes.push(OP.MOVE_32_32, ...lc(0), ...destination);
    this.bytes.push(OP.MOVE_8_8, ...source, ...destination);
  }

  private wordParameter(value: IRValue): number[] | undefined {
    const source = this.parameter(value);
    if (!source) return undefined;
    const target = this.scratch(2);
    this.bytes.push(
      this.typeOf(value)?.kind === "number" ? OP.MOVE_F_16 : OP.MOVE_32_16,
      ...source,
      ...lv(target),
    );
    return lv(target);
  }

  private byteResult(target: Allocation, emit: (destination: number[]) => void): void {
    if (target.type.kind === "boolean") {
      emit(this.location(target));
      return;
    }
    const scratch = this.scratch(1);
    emit(lv(scratch));
    this.unsignedByte(lv(scratch), this.location(target));
  }

  private motorSyncParameters(
    speed1: IRValue,
    speed2: IRValue,
  ): { speed: number[]; turn: number[] } | undefined {
    const first = this.floatParameter(speed1);
    const second = this.floatParameter(speed2);
    if (!first || !second) return undefined;
    const absoluteFirst = this.scratch(4);
    const absoluteSecond = this.scratch(4);
    const chooseFirst = this.scratch(1);
    const chooseFirstFloat = this.scratch(4);
    const chooseSecondFloat = this.scratch(4);
    const firstContribution = this.scratch(4);
    const secondContribution = this.scratch(4);
    const speed = this.scratch(4);
    const isZero = this.scratch(1);
    const zeroFloat = this.scratch(4);
    const difference = this.scratch(4);
    const turnFloat = this.scratch(4);
    const speedByte = this.scratch(1);
    const turnWord = this.scratch(2);
    this.bytes.push(OP.MATH, ...lc(MATH.ABS), ...first, ...lv(absoluteFirst));
    this.bytes.push(OP.MATH, ...lc(MATH.ABS), ...second, ...lv(absoluteSecond));
    this.bytes.push(OP.CP_GTEQ_F, ...lv(absoluteFirst), ...lv(absoluteSecond), ...lv(chooseFirst));
    this.bytes.push(OP.MOVE_8_F, ...lv(chooseFirst), ...lv(chooseFirstFloat));
    this.bytes.push(OP.SUB_F, ...lcf(1), ...lv(chooseFirstFloat), ...lv(chooseSecondFloat));
    this.bytes.push(OP.MUL_F, ...lv(chooseFirstFloat), ...first, ...lv(firstContribution));
    this.bytes.push(OP.MUL_F, ...lv(chooseSecondFloat), ...second, ...lv(secondContribution));
    this.bytes.push(OP.ADD_F, ...lv(firstContribution), ...lv(secondContribution), ...lv(speed));
    this.bytes.push(OP.CP_EQ_F, ...lv(speed), ...lcf(0), ...lv(isZero));
    this.bytes.push(OP.MOVE_8_F, ...lv(isZero), ...lv(zeroFloat));
    this.bytes.push(OP.ADD_F, ...lv(speed), ...lv(zeroFloat), ...lv(speed));
    this.bytes.push(OP.SUB_F, ...first, ...second, ...lv(difference));
    this.bytes.push(OP.MUL_F, ...lcf(100), ...lv(difference), ...lv(turnFloat));
    this.bytes.push(OP.DIV_F, ...lv(turnFloat), ...lv(speed), ...lv(turnFloat));
    this.bytes.push(OP.MOVE_F_8, ...lv(speed), ...lv(speedByte));
    this.bytes.push(OP.MOVE_F_16, ...lv(turnFloat), ...lv(turnWord));
    return { speed: lv(speedByte), turn: lv(turnWord) };
  }

  private motorAddress(
    value: IRValue,
  ): { layer: number[]; mask: number[]; port: number[] } | undefined {
    const fixedMask = motorMask(value);
    if (fixedMask !== undefined) {
      // Commands accept a port mask (for example "AB").  Operations that
      // need one physical port use the first selected port, as Clev3r does.
      const port = Math.max(0, Math.floor(Math.log2(fixedMask)));
      return { layer: lc(0), mask: lc(fixedMask), port: lc(port) };
    }
    if (value.kind !== "variable" || this.typeOf(value)?.kind !== "string") return undefined;
    const allocation = this.allocationFor(value.name);
    if (!allocation) return undefined;
    const letter = this.scratch(4);
    const port = this.scratch(4);
    const shift = this.scratch(1);
    const mask = this.scratch(1);
    const layerCharacter = this.scratch(4);
    const layer = this.scratch(4);
    const noLayer = this.newLabel("motor-no-layer");
    const done = this.newLabel("motor-layer-done");
    this.bytes.push(OP.MOVE_8_32, ...this.location(allocation), ...lv(letter));
    this.bytes.push(OP.SUB_32, ...lv(letter), ...lc(65), ...lv(port));
    this.bytes.push(OP.MOVE_32_8, ...lv(port), ...lv(shift));
    this.bytes.push(OP.RL_8, ...lc(1), ...lv(shift), ...lv(mask));
    this.bytes.push(OP.MOVE_8_32, ...this.location(allocation, 1), ...lv(layerCharacter));
    this.bytes.push(OP.CP_NEQ_32, ...lv(layerCharacter), ...lc(0), ...lv(shift));
    this.bytes.push(OP.JR_FALSE, ...lv(shift));
    this.addPatch(noLayer);
    this.bytes.push(OP.SUB_32, ...lv(layerCharacter), ...lc(49), ...lv(layer));
    this.bytes.push(OP.JR);
    this.addPatch(done);
    this.markLabel(noLayer);
    this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(layer));
    this.markLabel(done);
    return { layer: lv(layer), mask: lv(mask), port: lv(port) };
  }

  private buttonText(target: Allocation, command: number): void {
    this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...lcs(""), ...this.location(target));
    for (const [button, letter] of [
      [1, "U"],
      [3, "D"],
      [5, "L"],
      [4, "R"],
      [2, "E"],
    ] as const) {
      const pressed = this.scratch(1);
      this.bytes.push(OP.UI_BUTTON, ...lc(command), ...lc(button), ...lv(pressed));
      this.bytes.push(OP.JR_FALSE, ...lv(pressed));
      const jumpAt = this.bytes.length;
      const placeholder = relativeOffset(0);
      this.bytes.push(...placeholder);
      const afterJump = this.bytes.length;
      this.bytes.push(
        OP.STRING,
        ...lc(STRING.ADD),
        ...this.location(target),
        ...lcs(letter),
        ...this.location(target),
      );
      const offset = relativeOffset(this.bytes.length - afterJump);
      this.bytes.splice(jumpAt, placeholder.length, ...offset);
    }
  }

  private newLabel(description: string): symbol {
    return Symbol(`${this.fn.name}:${description}`);
  }

  private markLabel(label: Label): void {
    this.labels.set(label, this.bytes.length);
  }

  private arrayLoop(size: number[], body: (index: number) => void): void {
    const index = this.scratch(4);
    const active = this.scratch(1);
    const loop = this.newLabel("array-loop");
    const done = this.newLabel("array-done");
    this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(index));
    this.markLabel(loop);
    this.bytes.push(OP.CP_LT_32, ...lv(index), ...size, ...lv(active));
    this.bytes.push(OP.JR_FALSE, ...lv(active));
    this.addPatch(done);
    body(index);
    this.bytes.push(OP.ADD_32, ...lv(index), ...lc(1), ...lv(index));
    this.bytes.push(OP.JR);
    this.addPatch(loop);
    this.markLabel(done);
  }

  private arrayConditional(condition: number[], whenTrue: () => void): void {
    const done = this.newLabel("array-condition-done");
    this.bytes.push(OP.JR_FALSE, ...condition);
    this.addPatch(done);
    whenTrue();
    this.markLabel(done);
  }

  private assertionFailure(message: number[]): void {
    this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.SELECT_FONT), ...lc(1));
    this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.TEXT), ...lc(1), ...lc(0), ...lc(0), ...message);
    this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.UPDATE));
    this.bytes.push(OP.PROGRAM_STOP, ...lc(1));
  }

  private byteToBinary(value: number[], target: Allocation): void {
    for (const [index, mask] of [128, 64, 32, 16, 8, 4, 2, 1].entries()) {
      const masked = this.scratch(1);
      const zero = this.newLabel("binary-zero");
      const done = this.newLabel("binary-bit-done");
      this.bytes.push(OP.AND_8, ...value, ...lc(mask), ...lv(masked));
      this.bytes.push(OP.JR_FALSE, ...lv(masked));
      this.addPatch(zero);
      this.bytes.push(OP.MOVE_8_8, ...lc(49), ...lv(target.offset + index));
      this.bytes.push(OP.JR);
      this.addPatch(done);
      this.markLabel(zero);
      this.bytes.push(OP.MOVE_8_8, ...lc(48), ...lv(target.offset + index));
      this.markLabel(done);
    }
    this.bytes.push(OP.MOVE_8_8, ...lc(0), ...lv(target.offset + 8));
  }

  private typeOf(value: IRValue): IRType | undefined {
    if (value.kind !== "variable") return { kind: value.kind };
    return this.allocationFor(value.name)?.type;
  }

  /** Maps CLEV3R's one-based, daisy-chain-aware sensor number to EV3 layer/port bytes. */
  private sensorAddress(value: IRValue): { layer: number[]; port: number[] } | undefined {
    if ((value.kind === "integer" || value.kind === "number") && Number.isInteger(value.value)) {
      if (value.value < 1 || value.value > 16) return undefined;
      return { layer: lc(Math.floor((value.value - 1) / 4)), port: lc((value.value - 1) % 4) };
    }
    const rawPort = this.byteParameter(value);
    if (!rawPort) return undefined;
    const portNumber = this.scratch(4);
    const layerNumber = this.scratch(4);
    const layerTimesFour = this.scratch(4);
    const portNumberWithinLayer = this.scratch(4);
    const layer = this.scratch(1);
    const port = this.scratch(1);
    this.bytes.push(OP.MOVE_8_32, ...rawPort, ...lv(portNumber));
    this.bytes.push(OP.SUB_32, ...lv(portNumber), ...lc(1), ...lv(portNumber));
    this.bytes.push(OP.DIV_32, ...lv(portNumber), ...lc(4), ...lv(layerNumber));
    this.bytes.push(OP.MUL_32, ...lv(layerNumber), ...lc(4), ...lv(layerTimesFour));
    this.bytes.push(
      OP.SUB_32,
      ...lv(portNumber),
      ...lv(layerTimesFour),
      ...lv(portNumberWithinLayer),
    );
    this.bytes.push(OP.MOVE_32_8, ...lv(layerNumber), ...lv(layer));
    this.bytes.push(OP.MOVE_32_8, ...lv(portNumberWithinLayer), ...lv(port));
    return { layer: lv(layer), port: lv(port) };
  }

  private fixedSensorByteCount(
    value: IRValue | undefined,
    maximum: number,
    description: string,
    instruction: IRInstruction,
  ): number | undefined {
    if (
      !value ||
      (value.kind !== "integer" && value.kind !== "number") ||
      !Number.isInteger(value.value) ||
      value.value < 0 ||
      value.value > maximum
    ) {
      this.diagnostics.push(
        diagnostic(
          "EV32024",
          `${description} must be a constant whole number from 0 through ${maximum}.`,
          instruction.span,
        ),
      );
      return undefined;
    }
    return value.value;
  }

  private copyRowToByteArray(source: IRValue, bytes: number): number | undefined {
    const sourceParameter = this.parameter(source);
    if (!sourceParameter) return undefined;
    const handle = this.scratch(2);
    this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_8), ...lc(bytes), ...lv(handle));
    for (let index = 0; index < bytes; index += 1) {
      const value = this.scratch(4);
      const byte = this.scratch(4);
      this.bytes.push(OP.ARRAY_READ, ...sourceParameter, ...lc(index), ...lv(value));
      this.bytes.push(OP.MOVE_F_32, ...lv(value), ...lv(byte));
      this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lc(index), ...lv(byte));
    }
    return handle;
  }

  private i2cResultArray(readHandle: number, bytes: number, target: Allocation): void {
    const result = this.scratch(2);
    this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...lc(bytes), ...lv(result));
    for (let index = 0; index < bytes; index += 1) {
      const byte = this.scratch(1);
      const value = this.scratch(4);
      this.bytes.push(OP.ARRAY_READ, ...lv(readHandle), ...lc(index), ...lv(byte));
      this.unsignedByte(lv(byte), lv(value));
      this.bytes.push(OP.MOVE_32_F, ...lv(value), ...lv(value));
      this.bytes.push(OP.ARRAY_WRITE, ...lv(result), ...lc(index), ...lv(value));
    }
    this.bytes.push(OP.MOVE_16_32, ...lv(result), ...this.location(target));
    this.retainCallLocalArray(lv(result), target);
  }

  private fileName(value: IRValue): number[] | undefined {
    const source = this.parameter(value);
    if (!source) return undefined;
    const fullName = this.scratch(512);
    const firstCharacter = this.scratch(1);
    const absolute = this.scratch(1);
    const relativePath = this.newLabel("relative-file-path");
    const done = this.newLabel("file-path-ready");
    this.bytes.push(OP.MOVE_8_8, ...source, ...lv(firstCharacter));
    this.bytes.push(OP.CP_EQ_8, ...lv(firstCharacter), ...lc(47), ...lv(absolute));
    this.bytes.push(OP.JR_FALSE, ...lv(absolute));
    this.addPatch(relativePath);
    this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...source, ...lv(fullName));
    this.bytes.push(OP.JR);
    this.addPatch(done);
    this.markLabel(relativePath);
    this.bytes.push(
      OP.STRING,
      ...lc(STRING.ADD),
      ...lcs((this.runtimeDirectory ?? "/home/root/lms2012/prjs") + "/"),
      ...source,
      ...lv(fullName),
    );
    this.markLabel(done);
    return lv(fullName);
  }

  /** Resolves a project media name to the EV3 file-system path and extension. */
  private mediaFileName(value: IRValue, extension: string): number[] | undefined {
    const name = this.fileName(value);
    if (!name) return undefined;
    const fullName = this.scratch(512);
    this.bytes.push(OP.STRING, ...lc(STRING.ADD), ...name, ...lcs(extension), ...lv(fullName));
    return lv(fullName);
  }

  private scratch(bytes: number): number {
    const offset = Math.ceil(this.scratchOffset / 4) * 4;
    this.scratchOffset = offset + bytes;
    this.localBytes = Math.max(this.localBytes, this.scratchOffset);
    return offset;
  }

  private timerBaseline(index: number): number {
    if (this.timerBaselines === undefined) throw new Error("Timer storage was not allocated.");
    return this.timerBaselines + index * 4;
  }

  private lcdAutoUpdate(): void {
    if (!this.hasLcdUpdateControl) {
      this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.UPDATE));
      return;
    }
    const enabled = this.scratch(1);
    const done = this.newLabel("lcd-auto-update-done");
    this.bytes.push(OP.CP_EQ_32, ...gv(4), ...lc(0), ...lv(enabled));
    this.bytes.push(OP.JR_FALSE, ...lv(enabled));
    this.addPatch(done);
    this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.UPDATE));
    this.markLabel(done);
  }

  private instruction(instruction: IRInstruction): void {
    const target =
      "target" in instruction && instruction.target
        ? this.allocationFor(instruction.target)
        : undefined;
    if ("target" in instruction && instruction.target && !target) {
      this.diagnostics.push(
        diagnostic("EV31004", `No allocation for '${instruction.target}'.`, instruction.span),
      );
      return;
    }
    if (instruction.op === "assign" && target) {
      const source = this.parameter(instruction.value);
      if (!source) {
        this.diagnostics.push(
          diagnostic("EV32001", "Unable to encode an assignment source.", instruction.span),
        );
        return;
      }
      if (target.type.kind === "array") {
        this.bytes.push(OP.MOVE_16_32, ...source, ...this.location(target));
        return;
      }
      if (target.type.kind === "string") {
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...source, ...this.location(target));
        return;
      }
      const sourceType = this.typeOf(instruction.value)?.kind;
      const opcode =
        target.type.kind === "boolean"
          ? OP.MOVE_8_8
          : target.type.kind === "integer"
            ? sourceType === "boolean"
              ? OP.MOVE_8_32
              : OP.MOVE_32_32
            : sourceType === "boolean"
              ? OP.MOVE_8_F
              : sourceType === "integer"
                ? OP.MOVE_32_F
                : OP.MOVE_F_F;
      this.bytes.push(opcode, ...source, ...this.location(target));
      return;
    }
    if (instruction.op === "unary" && target) {
      const source = this.parameter(instruction.value);
      if (!source) return;
      if (instruction.operator === "not")
        this.bytes.push(OP.CP_EQ_8, ...source, ...lc(0), ...this.location(target));
      else if (target.type.kind === "integer")
        this.bytes.push(OP.SUB_32, ...lc(0), ...source, ...this.location(target));
      else this.bytes.push(OP.SUB_F, ...lcf(0), ...source, ...this.location(target));
      return;
    }
    if (instruction.op === "binary" && target) {
      const left = this.parameter(instruction.left);
      const right = this.parameter(instruction.right);
      if (!left || !right) return;
      const leftType = this.typeOf(instruction.left)?.kind;
      const rightType = this.typeOf(instruction.right)?.kind;
      if (target.type.kind === "string" && instruction.operator === "+") {
        const leftText = this.textParameter(instruction.left);
        const rightText = this.textParameter(instruction.right);
        if (!leftText || !rightText) return;
        this.bytes.push(
          OP.STRING,
          ...lc(STRING.ADD),
          ...leftText,
          ...rightText,
          ...this.location(target),
        );
        return;
      }
      if (leftType === "string" && rightType === "string" && instruction.operator === "=") {
        this.bytes.push(
          OP.STRING,
          ...lc(STRING.COMPARE),
          ...left,
          ...right,
          ...this.location(target),
        );
        return;
      }
      const integerOperands =
        target.type.kind !== "number" &&
        this.typeOf(instruction.left)?.kind === "integer" &&
        this.typeOf(instruction.right)?.kind === "integer";
      const numericLeft = integerOperands ? left : this.floatParameter(instruction.left);
      const numericRight = integerOperands ? right : this.floatParameter(instruction.right);
      if (!numericLeft || !numericRight) return;
      const floatOpcodes: Partial<
        Record<Extract<IRInstruction, { op: "binary" }>["operator"], number>
      > = {
        "+": OP.ADD_F,
        "-": OP.SUB_F,
        "*": OP.MUL_F,
        "/": OP.DIV_F,
        "<": OP.CP_LT_F,
        ">": OP.CP_GT_F,
        "<=": OP.CP_LTEQ_F,
        ">=": OP.CP_GTEQ_F,
        "=": OP.CP_EQ_F,
        "<>": OP.CP_NEQ_F,
      };
      const integerOpcodes: typeof floatOpcodes = {
        "+": OP.ADD_32,
        "-": OP.SUB_32,
        "*": OP.MUL_32,
        "/": OP.DIV_32,
        "<": OP.CP_LT_32,
        ">": OP.CP_GT_32,
        "<=": OP.CP_LTEQ_32,
        ">=": OP.CP_GTEQ_32,
        "=": OP.CP_EQ_32,
        "<>": OP.CP_NEQ_32,
      };
      const opcodes: typeof floatOpcodes = {
        ...(integerOperands ? integerOpcodes : floatOpcodes),
        and: OP.AND_8,
        or: OP.OR_8,
      };
      if (instruction.operator === "%") {
        if (integerOperands) {
          const quotient = this.scratch(4);
          const product = this.scratch(4);
          this.bytes.push(OP.DIV_32, ...left, ...right, ...lv(quotient));
          this.bytes.push(OP.MUL_32, ...lv(quotient), ...right, ...lv(product));
          this.bytes.push(OP.SUB_32, ...left, ...lv(product), ...this.location(target));
        } else {
          this.bytes.push(
            OP.MATH,
            ...lc(MATH.MOD),
            ...numericLeft,
            ...numericRight,
            ...this.location(target),
          );
        }
        return;
      }
      const opcode = opcodes[instruction.operator];
      if (opcode === undefined) {
        this.diagnostics.push(
          diagnostic(
            "EV32002",
            `Operator '${instruction.operator}' is not lowered yet.`,
            instruction.span,
          ),
        );
        return;
      }
      this.bytes.push(opcode, ...numericLeft, ...numericRight, ...this.location(target));
      return;
    }
    if (instruction.op === "call") {
      const callable = this.callables.get(instruction.functionName.toLocaleLowerCase("en-US"));
      if (!callable) {
        this.diagnostics.push(
          diagnostic(
            "EV32003",
            `Unknown user function '${instruction.functionName}'.`,
            instruction.span,
          ),
        );
        return;
      }
      const ordered = orderedParameters(callable.fn);
      const callArguments: number[][] = [];
      for (const parameter of ordered) {
        const index = callable.fn.parameters.indexOf(parameter);
        const value = instruction.args[index];
        if (!value) {
          this.diagnostics.push(
            diagnostic(
              "EV32003",
              `Missing argument for user function '${instruction.functionName}'.`,
              instruction.span,
            ),
          );
          return;
        }
        if (parameter.direction === "out") {
          if (value.kind !== "variable") {
            this.diagnostics.push(
              diagnostic(
                "EV32003",
                `Output argument '${parameter.name}' must be a variable.`,
                instruction.span,
              ),
            );
            return;
          }
          const output = this.parameter(value);
          if (!output) return;
          callArguments.push(output);
        } else {
          const input =
            parameter.type.kind === "number" ? this.floatParameter(value) : this.parameter(value);
          if (!input) return;
          callArguments.push(input);
        }
      }
      if (callable.fn.returnType.kind !== "void") {
        if (!target) {
          this.diagnostics.push(
            diagnostic(
              "EV32003",
              `Function '${instruction.functionName}' requires a return target.`,
              instruction.span,
            ),
          );
          return;
        }
        callArguments.push(this.location(target));
      }
      this.bytes.push(OP.CALL, ...lc(callable.objectId), ...lc(callArguments.length));
      for (const argument of callArguments) this.bytes.push(...argument);
      return;
    }
    if (instruction.op === "thread-start") {
      const objectId = this.threadObjects.get(instruction.functionName.toLocaleLowerCase("en-US"));
      if (objectId === undefined) {
        this.diagnostics.push(
          diagnostic(
            "EV32030",
            `No EV3 thread object for '${instruction.functionName}'.`,
            instruction.span,
          ),
        );
        return;
      }
      this.bytes.push(OP.OBJECT_START, ...lc(objectId));
      return;
    }
    if (instruction.op === "ev3-call") this.ev3Call(instruction, target);
  }

  private ev3Call(
    instruction: Extract<IRInstruction, { op: "ev3-call" }>,
    target: Allocation | undefined,
  ): void {
    const signature = getEV3Operation(instruction.operation);
    const args = instruction.args.map((value, index) => {
      const expected = signature?.parameters[index];
      const accepted = Array.isArray(expected) ? expected : [expected];
      return accepted.includes("integer") && !accepted.includes("number")
        ? this.integerParameter(value)
        : this.parameter(value);
    });
    if (args.some((value) => !value)) {
      this.diagnostics.push(
        diagnostic("EV31005", "Unable to encode an EV3 call argument.", instruction.span),
      );
      return;
    }
    const motorPercentageIndex =
      /^Motor[ABCD]{1,2}\.(SetPower|StartPower|SetSpeed|StartSpeed)$/.test(instruction.operation)
        ? 0
        : [
              "Motor.Start",
              "Motor.StartPower",
              "Motor.StartSteer",
              "Motor.Move",
              "Motor.MovePower",
              "Motor.Schedule",
              "Motor.SchedulePower",
              "Motor.ScheduleSteer",
              "Motor.MoveSteer",
            ].includes(instruction.operation)
          ? 1
          : -1;
    if (motorPercentageIndex >= 0)
      args[motorPercentageIndex] = this.motorPercentage(instruction.args[motorPercentageIndex]!);
    const arg = (index: number): number[] => args[index]!;
    const floatArg = (index: number): number[] | undefined =>
      this.floatParameter(instruction.args[index]!);
    const timer = /^Time\.(Get|Reset)([1-9])$/.exec(instruction.operation);
    if (timer) {
      const baseline = this.timerBaseline(Number(timer[2]) - 1);
      if (timer[1] === "Reset") {
        this.bytes.push(OP.TIMER_READ, ...gv(baseline));
      } else if (target) {
        this.bytes.push(OP.TIMER_READ, ...this.location(target));
        this.bytes.push(
          OP.SUB_32,
          ...this.location(target),
          ...gv(baseline),
          ...this.location(target),
        );
      }
      return;
    }
    const legacyMotor = /^Motor([ABCD]{1,2})\.(.+)$/.exec(instruction.operation);
    if (legacyMotor) {
      const mask = motorMask({ kind: "string", value: legacyMotor[1]! });
      if (!mask) return;
      const method = legacyMotor[2]!;
      const port = Math.log2(mask);
      if (method === "Off") this.bytes.push(OP.OUTPUT_STOP, ...lc(0), ...lc(mask), ...lc(0));
      else if (method === "OffAndBrake")
        this.bytes.push(OP.OUTPUT_STOP, ...lc(0), ...lc(mask), ...lc(1));
      else if (method === "SetSpeed")
        this.bytes.push(OP.OUTPUT_SPEED, ...lc(0), ...lc(mask), ...arg(0));
      else if (method === "SetPower")
        this.bytes.push(OP.OUTPUT_POWER, ...lc(0), ...lc(mask), ...arg(0));
      else if (method === "Start") this.bytes.push(OP.OUTPUT_START, ...lc(0), ...lc(mask));
      else if (method === "StartSpeed")
        this.bytes.push(
          OP.OUTPUT_SPEED,
          ...lc(0),
          ...lc(mask),
          ...arg(0),
          OP.OUTPUT_START,
          ...lc(0),
          ...lc(mask),
        );
      else if (method === "StartPower")
        this.bytes.push(
          OP.OUTPUT_POWER,
          ...lc(0),
          ...lc(mask),
          ...arg(0),
          OP.OUTPUT_START,
          ...lc(0),
          ...lc(mask),
        );
      else if (method === "ResetCount") this.bytes.push(OP.OUTPUT_RESET, ...lc(0), ...lc(mask));
      else if (method === "SetDirectPolarity")
        this.bytes.push(OP.OUTPUT_POLARITY, ...lc(0), ...lc(mask), ...lc(1));
      else if (method === "SetReversPolarity")
        this.bytes.push(OP.OUTPUT_POLARITY, ...lc(0), ...lc(mask), ...lc(-1));
      else if (method === "IsLarge" && Number.isInteger(port))
        this.bytes.push(OP.OUTPUT_SET_TYPE, ...lc(0), ...lc(port), ...lc(7));
      else if (method === "IsMedium" && Number.isInteger(port))
        this.bytes.push(OP.OUTPUT_SET_TYPE, ...lc(0), ...lc(port), ...lc(8));
      else if (method === "GetTacho" && target && Number.isInteger(port))
        this.bytes.push(OP.OUTPUT_GET_COUNT, ...lc(0), ...lc(port), ...this.location(target));
      else if (method === "GetSpeed" && target && Number.isInteger(port)) {
        const speed = this.scratch(1);
        const tacho = this.scratch(4);
        this.bytes.push(OP.OUTPUT_READ, ...lc(0), ...lc(port), ...lv(speed), ...lv(tacho));
        this.bytes.push(OP.MOVE_8_32, ...lv(speed), ...this.location(target));
      } else {
        this.diagnostics.push(
          diagnostic(
            "EV32010",
            `Unsupported legacy motor call '${instruction.operation}'.`,
            instruction.span,
          ),
        );
      }
      return;
    }
    switch (instruction.operation) {
      case "Assert.Failed":
        this.assertionFailure(arg(0));
        return;
      case "Assert.Equal":
      case "Assert.NotEqual":
      case "Assert.Less":
      case "Assert.Greater":
      case "Assert.LessEqual":
      case "Assert.GreaterEqual":
      case "Assert.Near": {
        const passed = this.scratch(1);
        const leftType = this.typeOf(instruction.args[0]!)?.kind;
        const rightType = this.typeOf(instruction.args[1]!)?.kind;
        if (
          (instruction.operation === "Assert.Equal" ||
            instruction.operation === "Assert.NotEqual") &&
          leftType === "string" &&
          rightType === "string"
        ) {
          this.bytes.push(OP.STRING, ...lc(STRING.COMPARE), ...arg(0), ...arg(1), ...lv(passed));
          if (instruction.operation === "Assert.NotEqual")
            this.bytes.push(OP.CP_EQ_8, ...lv(passed), ...lc(0), ...lv(passed));
        } else if (instruction.operation === "Assert.Near") {
          const left = this.floatParameter(instruction.args[0]!);
          const right = this.floatParameter(instruction.args[1]!);
          if (!left || !right) break;
          const difference = this.scratch(4);
          this.bytes.push(OP.SUB_F, ...left, ...right, ...lv(difference));
          this.bytes.push(OP.MATH, ...lc(MATH.ABS), ...lv(difference), ...lv(difference));
          this.bytes.push(OP.CP_LTEQ_F, ...lv(difference), ...lcf(0.0001), ...lv(passed));
        } else {
          const numeric = leftType === "number" || rightType === "number";
          const left = numeric ? this.floatParameter(instruction.args[0]!) : arg(0);
          const right = numeric ? this.floatParameter(instruction.args[1]!) : arg(1);
          if (!left || !right) break;
          const operation = instruction.operation;
          const opcode = numeric
            ? {
                "Assert.Equal": OP.CP_EQ_F,
                "Assert.NotEqual": OP.CP_NEQ_F,
                "Assert.Less": OP.CP_LT_F,
                "Assert.Greater": OP.CP_GT_F,
                "Assert.LessEqual": OP.CP_LTEQ_F,
                "Assert.GreaterEqual": OP.CP_GTEQ_F,
              }[operation]
            : {
                "Assert.Equal": OP.CP_EQ_32,
                "Assert.NotEqual": OP.CP_NEQ_32,
                "Assert.Less": OP.CP_LT_32,
                "Assert.Greater": OP.CP_GT_32,
                "Assert.LessEqual": OP.CP_LTEQ_32,
                "Assert.GreaterEqual": OP.CP_GTEQ_32,
              }[operation];
          if (opcode === undefined) break;
          this.bytes.push(opcode, ...left, ...right, ...lv(passed));
        }
        const failed = this.newLabel("assertion-failed");
        const done = this.newLabel("assertion-done");
        this.bytes.push(OP.JR_FALSE, ...lv(passed));
        this.addPatch(failed);
        this.bytes.push(OP.JR);
        this.addPatch(done);
        this.markLabel(failed);
        this.assertionFailure(arg(2));
        this.markLabel(done);
        return;
      }
      case "Mailbox.Create":
      case "Mailbox.CreateForNumber": {
        if (!target) break;
        const id = this.mailboxAllocator.next;
        this.mailboxAllocator.next += 1;
        if (id >= 30) {
          this.diagnostics.push(
            diagnostic("EV32023", "EV3 supports at most 30 mailboxes.", instruction.span),
          );
          return;
        }
        this.bytes.push(
          OP.MAILBOX_OPEN,
          ...lc(id),
          ...arg(0),
          ...lc(instruction.operation === "Mailbox.Create" ? 4 : 3),
          ...lc(0),
          ...lc(0),
        );
        this.bytes.push(OP.MOVE_32_32, ...lc(id), ...this.location(target));
        return;
      }
      case "Mailbox.Send":
        this.bytes.push(
          OP.MAILBOX_WRITE,
          ...arg(0),
          ...lc(0),
          ...arg(1),
          ...lc(4),
          ...lc(1),
          ...arg(2),
        );
        return;
      case "Mailbox.SendNumber": {
        const value = this.floatParameter(instruction.args[2]!);
        if (!value) break;
        this.bytes.push(
          OP.MAILBOX_WRITE,
          ...arg(0),
          ...lc(0),
          ...arg(1),
          ...lc(3),
          ...lc(1),
          ...value,
        );
        return;
      }
      case "Mailbox.IsAvailable": {
        if (!target) break;
        const busy = this.scratch(1);
        this.bytes.push(OP.MAILBOX_TEST, ...arg(0), ...lv(busy));
        this.bytes.push(OP.CP_EQ_8, ...lv(busy), ...lc(0), ...this.location(target));
        return;
      }
      case "Mailbox.Receive":
        if (!target) break;
        this.bytes.push(OP.MAILBOX_READY, ...arg(0));
        this.bytes.push(
          OP.MAILBOX_READ,
          ...arg(0),
          ...lc(STRING_BYTES),
          ...lc(1),
          ...this.location(target),
        );
        return;
      case "Mailbox.ReceiveNumber":
        if (!target) break;
        this.bytes.push(OP.MAILBOX_READY, ...arg(0));
        this.bytes.push(OP.MAILBOX_READ, ...arg(0), ...lc(4), ...lc(1), ...this.location(target));
        return;
      case "Mailbox.Connect":
        this.bytes.push(OP.COM_SET, ...lc(7), ...lc(2), ...arg(0), ...lc(1));
        return;
      case "Vector.Init": {
        if (!target) break;
        const value = this.floatParameter(instruction.args[1]!);
        if (!value) break;
        const handle = this.scratch(2);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...arg(0), ...lv(handle));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.FILL), ...lv(handle), ...value);
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        return;
      }
      case "Vector.Data": {
        if (!target) break;
        const size = arg(0);
        const text = arg(1);
        const handle = this.scratch(2);
        const source = this.scratch(STRING_BYTES);
        const token = this.scratch(STRING_BYTES);
        const sourceIndex = this.scratch(4);
        const tokenIndex = this.scratch(4);
        const tokenLength = this.scratch(4);
        const filled = this.scratch(4);
        const character = this.scratch(1);
        const equal = this.scratch(1);
        const parsed = this.scratch(4);
        const nonempty = this.scratch(1);
        const loop = this.newLabel("vector-data-loop");
        const process = this.newLabel("vector-data-process");
        const copy = this.newLabel("vector-data-copy");
        const delimiter = this.newLabel("vector-data-delimiter");
        const finalValue = this.newLabel("vector-data-final");
        const afterDelimiter = this.newLabel("vector-data-after-delimiter");
        const done = this.newLabel("vector-data-done");
        const empty = this.newLabel("vector-data-empty");
        const positive = this.scratch(1);
        this.bytes.push(OP.CP_GT_32, ...size, ...lc(0), ...lv(positive));
        this.bytes.push(OP.JR_FALSE, ...lv(positive));
        this.addPatch(empty);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...size, ...lv(handle));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.FILL), ...lv(handle), ...lcf(0));
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...text, ...lv(source));
        this.bytes.push(OP.MOVE_32_32, ...lc(source), ...lv(sourceIndex));
        this.bytes.push(OP.MOVE_32_32, ...lc(token), ...lv(tokenIndex));
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(tokenLength));
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(filled));
        this.markLabel(loop);
        this.bytes.push(
          OP.MEMORY_READ,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(sourceIndex),
          ...lc(1),
          ...lv(character),
        );
        this.bytes.push(OP.CP_EQ_8, ...lv(character), ...lc(0), ...lv(equal));
        this.bytes.push(OP.JR_FALSE, ...lv(equal));
        this.addPatch(process);
        this.bytes.push(OP.JR);
        this.addPatch(finalValue);
        this.markLabel(process);
        this.bytes.push(OP.CP_EQ_8, ...lv(character), ...lc(32), ...lv(equal));
        this.bytes.push(OP.JR_FALSE, ...lv(equal));
        this.addPatch(copy);
        this.bytes.push(OP.JR);
        this.addPatch(delimiter);
        this.markLabel(copy);
        this.bytes.push(
          OP.MEMORY_WRITE,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(tokenIndex),
          ...lc(1),
          ...lv(character),
        );
        this.bytes.push(OP.ADD_32, ...lv(tokenIndex), ...lc(1), ...lv(tokenIndex));
        this.bytes.push(OP.ADD_32, ...lv(tokenLength), ...lc(1), ...lv(tokenLength));
        this.bytes.push(OP.ADD_32, ...lv(sourceIndex), ...lc(1), ...lv(sourceIndex));
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(delimiter);
        this.bytes.push(OP.CP_GT_32, ...lv(tokenLength), ...lc(0), ...lv(nonempty));
        this.bytes.push(OP.JR_FALSE, ...lv(nonempty));
        this.addPatch(afterDelimiter);
        this.bytes.push(
          OP.MEMORY_WRITE,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(tokenIndex),
          ...lc(1),
          ...lc(0),
        );
        this.bytes.push(OP.STRING, ...lc(STRING.STRING_TO_VALUE), ...lv(token), ...lv(parsed));
        this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(filled), ...lv(parsed));
        this.bytes.push(OP.ADD_32, ...lv(filled), ...lc(1), ...lv(filled));
        this.bytes.push(OP.CP_LT_32, ...lv(filled), ...size, ...lv(positive));
        this.bytes.push(OP.JR_FALSE, ...lv(positive));
        this.addPatch(done);
        this.markLabel(afterDelimiter);
        this.bytes.push(OP.MOVE_32_32, ...lc(token), ...lv(tokenIndex));
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(tokenLength));
        this.bytes.push(OP.ADD_32, ...lv(sourceIndex), ...lc(1), ...lv(sourceIndex));
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(finalValue);
        this.bytes.push(OP.CP_GT_32, ...lv(tokenLength), ...lc(0), ...lv(nonempty));
        this.bytes.push(OP.JR_FALSE, ...lv(nonempty));
        this.addPatch(done);
        this.bytes.push(
          OP.MEMORY_WRITE,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(tokenIndex),
          ...lc(1),
          ...lc(0),
        );
        this.bytes.push(OP.STRING, ...lc(STRING.STRING_TO_VALUE), ...lv(token), ...lv(parsed));
        this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(filled), ...lv(parsed));
        this.bytes.push(OP.JR);
        this.addPatch(done);
        this.markLabel(empty);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...lc(0), ...lv(handle));
        this.markLabel(done);
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        return;
      }
      case "Vector.Add": {
        if (!target) break;
        const handle = this.scratch(2);
        const first = this.scratch(4);
        const second = this.scratch(4);
        const sum = this.scratch(4);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...arg(0), ...lv(handle));
        this.arrayLoop(arg(0), (index) => {
          this.bytes.push(OP.ARRAY_READ, ...arg(1), ...lv(index), ...lv(first));
          this.bytes.push(OP.ARRAY_READ, ...arg(2), ...lv(index), ...lv(second));
          this.bytes.push(OP.ADD_F, ...lv(first), ...lv(second), ...lv(sum));
          this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(index), ...lv(sum));
        });
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        return;
      }
      case "Vector.Sort": {
        if (!target) break;
        const handle = this.scratch(2);
        const value = this.scratch(4);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...arg(0), ...lv(handle));
        this.arrayLoop(arg(0), (index) => {
          this.bytes.push(OP.ARRAY_READ, ...arg(1), ...lv(index), ...lv(value));
          this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(index), ...lv(value));
        });
        const outer = this.scratch(4);
        const inner = this.scratch(4);
        const outerActive = this.scratch(1);
        const innerActive = this.scratch(1);
        const compare = this.scratch(1);
        const left = this.scratch(4);
        const right = this.scratch(4);
        const limit = this.scratch(4);
        const next = this.scratch(4);
        const outerLoop = this.newLabel("sort-outer");
        const outerDone = this.newLabel("sort-done");
        const innerLoop = this.newLabel("sort-inner");
        const innerDone = this.newLabel("sort-inner-done");
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(outer));
        this.markLabel(outerLoop);
        this.bytes.push(OP.CP_LT_32, ...lv(outer), ...arg(0), ...lv(outerActive));
        this.bytes.push(OP.JR_FALSE, ...lv(outerActive));
        this.addPatch(outerDone);
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(inner));
        this.bytes.push(OP.SUB_32, ...arg(0), ...lc(1), ...lv(limit));
        this.bytes.push(OP.SUB_32, ...lv(limit), ...lv(outer), ...lv(limit));
        this.markLabel(innerLoop);
        this.bytes.push(OP.CP_LT_32, ...lv(inner), ...lv(limit), ...lv(innerActive));
        this.bytes.push(OP.JR_FALSE, ...lv(innerActive));
        this.addPatch(innerDone);
        this.bytes.push(OP.ARRAY_READ, ...lv(handle), ...lv(inner), ...lv(left));
        this.bytes.push(OP.ADD_32, ...lv(inner), ...lc(1), ...lv(next));
        this.bytes.push(OP.ARRAY_READ, ...lv(handle), ...lv(next), ...lv(right));
        this.bytes.push(OP.CP_GT_F, ...lv(left), ...lv(right), ...lv(compare));
        this.arrayConditional(lv(compare), () => {
          this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(inner), ...lv(right));
          this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(next), ...lv(left));
        });
        this.bytes.push(OP.ADD_32, ...lv(inner), ...lc(1), ...lv(inner));
        this.bytes.push(OP.JR);
        this.addPatch(innerLoop);
        this.markLabel(innerDone);
        this.bytes.push(OP.ADD_32, ...lv(outer), ...lc(1), ...lv(outer));
        this.bytes.push(OP.JR);
        this.addPatch(outerLoop);
        this.markLabel(outerDone);
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        return;
      }
      case "Vector.Multiply": {
        if (!target) break;
        const total = this.scratch(4);
        const handle = this.scratch(2);
        const sum = this.scratch(4);
        const aIndex = this.scratch(4);
        const bIndex = this.scratch(4);
        const outputIndex = this.scratch(4);
        const aValue = this.scratch(4);
        const bValue = this.scratch(4);
        this.bytes.push(OP.MUL_32, ...arg(0), ...arg(1), ...lv(total));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...lv(total), ...lv(handle));
        this.arrayLoop(arg(0), (row) => {
          this.arrayLoop(arg(1), (column) => {
            this.bytes.push(OP.MOVE_F_F, ...lcf(0), ...lv(sum));
            this.arrayLoop(arg(2), (index) => {
              this.bytes.push(OP.MUL_32, ...lv(row), ...arg(2), ...lv(aIndex));
              this.bytes.push(OP.ADD_32, ...lv(aIndex), ...lv(index), ...lv(aIndex));
              this.bytes.push(OP.MUL_32, ...lv(index), ...arg(1), ...lv(bIndex));
              this.bytes.push(OP.ADD_32, ...lv(bIndex), ...lv(column), ...lv(bIndex));
              this.bytes.push(OP.ARRAY_READ, ...arg(3), ...lv(aIndex), ...lv(aValue));
              this.bytes.push(OP.ARRAY_READ, ...arg(4), ...lv(bIndex), ...lv(bValue));
              this.bytes.push(OP.MUL_F, ...lv(aValue), ...lv(bValue), ...lv(aValue));
              this.bytes.push(OP.ADD_F, ...lv(sum), ...lv(aValue), ...lv(sum));
            });
            this.bytes.push(OP.MUL_32, ...lv(row), ...arg(1), ...lv(outputIndex));
            this.bytes.push(OP.ADD_32, ...lv(outputIndex), ...lv(column), ...lv(outputIndex));
            this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(outputIndex), ...lv(sum));
          });
        });
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        return;
      }
      case "Row.Init": {
        if (!target) break;
        const length = this.integerParameter(instruction.args[0]!);
        const value = this.floatParameter(instruction.args[1]!);
        if (!length || !value) break;
        const handle = this.scratch(2);
        // EV3 ARRAY.CREATE_F takes a DATA32 element count.  Clev3r's
        // `number` values are floats, so passing one directly interprets its
        // IEEE-754 bits as the length (for example 42.0 becomes 0x42280000),
        // which can exhaust the brick and freeze its VM.
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...length, ...lv(handle));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.FILL), ...lv(handle), ...value);
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        return;
      }
      case "Row.Delete": {
        const handle = this.integerParameter(instruction.args[0]!);
        if (!handle) break;
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...handle);
        return;
      }
      case "Row.Read": {
        if (!target) break;
        const readArray = this.typeOf(instruction.args[0]!);
        if (readArray?.kind === "array" && readArray.element === "string") {
          this.readStringArray(arg(0), instruction.args[1]!, target);
          return;
        }
        {
          const index = this.integerParameter(instruction.args[1]!);
          if (!index) break;
          const handle = this.integerParameter(instruction.args[0]!);
          if (!handle) break;
          this.bytes.push(OP.ARRAY_READ, ...handle, ...index, ...this.location(target));
        }
        return;
      }
      case "Row.Write": {
        const writeArray = this.typeOf(instruction.args[0]!);
        if (writeArray?.kind === "array" && writeArray.element === "string") {
          this.writeStringArray(arg(0), instruction.args[1]!, instruction.args[2]!);
          return;
        }
        const index = this.integerParameter(instruction.args[1]!);
        const value = this.floatParameter(instruction.args[2]!);
        if (!index || !value) break;
        const handle = this.integerParameter(instruction.args[0]!);
        if (!handle) break;
        this.bytes.push(OP.ARRAY_WRITE, ...handle, ...index, ...value);
        return;
      }
      case "Row.Size": {
        if (!target) break;
        const size = this.scratch(4);
        const handle = this.integerParameter(instruction.args[0]!);
        if (!handle) break;
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.SIZE), ...handle, ...lv(size));
        this.bytes.push(
          target.type.kind === "number" ? OP.MOVE_32_F : OP.MOVE_32_32,
          ...lv(size),
          ...this.location(target),
        );
        return;
      }
      case "Row.Resize": {
        const length = this.integerParameter(instruction.args[1]!);
        if (!length) break;
        const handle = this.integerParameter(instruction.args[0]!);
        if (!handle) break;
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.RESIZE), ...handle, ...length);
        return;
      }
      case "Text.Append":
        if (!target) break;
        {
          const left = this.textParameter(instruction.args[0]!);
          const right = this.textParameter(instruction.args[1]!);
          if (!left || !right) break;
          this.bytes.push(
            OP.STRING,
            ...lc(STRING.ADD),
            ...left,
            ...right,
            ...this.location(target),
          );
        }
        return;
      case "Text.GetLength": {
        if (!target) break;
        const text = this.textParameter(instruction.args[0]!);
        if (!text) break;
        const length = this.scratch(2);
        this.bytes.push(OP.STRING, ...lc(STRING.GET_SIZE), ...text, ...lv(length));
        this.bytes.push(OP.MOVE_16_32, ...lv(length), ...this.location(target));
        return;
      }
      case "Text.GetCharacter":
        if (!target) break;
        this.bytes.push(OP.MOVE_32_8, ...arg(0), ...this.location(target));
        this.bytes.push(OP.MOVE_8_8, ...lc(0), ...lv(target.offset + 1));
        return;
      case "Text.GetCharacterCode":
        if (!target) break;
        {
          const text = this.textParameter(instruction.args[0]!);
          if (!text) break;
          this.bytes.push(OP.MOVE_8_32, ...text, ...this.location(target));
        }
        return;
      case "Text.IsSubText":
      case "Text.EndsWith":
      case "Text.StartsWith":
      case "Text.GetIndexOf": {
        if (!target) break;
        const sourceText = this.textParameter(instruction.args[0]!);
        const matchText = this.textParameter(instruction.args[1]!);
        if (!sourceText || !matchText) break;
        const textBuffer = this.scratch(STRING_BYTES);
        const candidate = this.scratch(STRING_BYTES);
        const textLength16 = this.scratch(2);
        const subtextLength16 = this.scratch(2);
        const textLength = this.scratch(4);
        const subtextLength = this.scratch(4);
        const limit = this.scratch(4);
        const index = this.scratch(4);
        const offset = this.scratch(4);
        const valid = this.scratch(1);
        const match = this.scratch(1);
        const loop = this.newLabel("text-search-loop");
        const found = this.newLabel("text-search-found");
        const missing = this.newLabel("text-search-missing");
        const done = this.newLabel("text-search-done");
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...sourceText, ...lv(textBuffer));
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...matchText, ...lv(candidate));
        this.bytes.push(OP.STRING, ...lc(STRING.GET_SIZE), ...sourceText, ...lv(textLength16));
        this.bytes.push(OP.STRING, ...lc(STRING.GET_SIZE), ...matchText, ...lv(subtextLength16));
        this.bytes.push(OP.MOVE_16_32, ...lv(textLength16), ...lv(textLength));
        this.bytes.push(OP.MOVE_16_32, ...lv(subtextLength16), ...lv(subtextLength));
        this.bytes.push(OP.CP_GT_32, ...lv(subtextLength), ...lc(0), ...lv(valid));
        this.bytes.push(OP.JR_FALSE, ...lv(valid));
        this.addPatch(missing);
        this.bytes.push(OP.CP_GTEQ_32, ...lv(textLength), ...lv(subtextLength), ...lv(valid));
        this.bytes.push(OP.JR_FALSE, ...lv(valid));
        this.addPatch(missing);
        this.bytes.push(OP.SUB_32, ...lv(textLength), ...lv(subtextLength), ...lv(limit));
        if (instruction.operation === "Text.StartsWith") {
          this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(index));
          this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(limit));
        } else if (instruction.operation === "Text.EndsWith") {
          this.bytes.push(OP.MOVE_32_32, ...lv(limit), ...lv(index));
        } else this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(index));
        this.markLabel(loop);
        this.bytes.push(OP.ADD_32, ...lc(textBuffer), ...lv(index), ...lv(offset));
        this.bytes.push(
          OP.MEMORY_READ,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(offset),
          ...lv(subtextLength),
          ...lv(candidate),
        );
        this.bytes.push(
          OP.STRING,
          ...lc(STRING.COMPARE),
          ...matchText,
          ...lv(candidate),
          ...lv(match),
        );
        this.bytes.push(OP.JR_TRUE, ...lv(match));
        this.addPatch(found);
        this.bytes.push(OP.ADD_32, ...lv(index), ...lc(1), ...lv(index));
        this.bytes.push(OP.CP_LTEQ_32, ...lv(index), ...lv(limit), ...lv(valid));
        this.bytes.push(OP.JR_FALSE, ...lv(valid));
        this.addPatch(missing);
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(found);
        if (instruction.operation === "Text.GetIndexOf")
          this.bytes.push(OP.ADD_32, ...lv(index), ...lc(1), ...this.location(target));
        else this.bytes.push(OP.MOVE_8_8, ...lc(1), ...this.location(target));
        this.bytes.push(OP.JR);
        this.addPatch(done);
        this.markLabel(missing);
        this.bytes.push(
          instruction.operation === "Text.GetIndexOf" ? OP.MOVE_32_32 : OP.MOVE_8_8,
          ...lc(0),
          ...this.location(target),
        );
        this.markLabel(done);
        return;
      }
      case "Text.GetSubText":
      case "Text.GetSubTextToEnd": {
        if (!target) break;
        const sourceText = this.textParameter(instruction.args[0]!);
        if (!sourceText) break;
        const buffer = this.scratch(STRING_BYTES);
        const length16 = this.scratch(2);
        const length = this.scratch(4);
        const start = this.scratch(4);
        const requested = this.scratch(4);
        const available = this.scratch(4);
        const offset = this.scratch(4);
        const size = this.scratch(4);
        const valid = this.scratch(1);
        const empty = this.newLabel("text-sub-empty");
        const clamp = this.newLabel("text-sub-clamp");
        const copy = this.newLabel("text-sub-copy");
        const done = this.newLabel("text-sub-done");
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...sourceText, ...lv(buffer));
        this.bytes.push(OP.STRING, ...lc(STRING.GET_SIZE), ...sourceText, ...lv(length16));
        this.bytes.push(OP.MOVE_16_32, ...lv(length16), ...lv(length));
        this.bytes.push(OP.MOVE_32_32, ...arg(1), ...lv(start));
        this.bytes.push(OP.SUB_32, ...lv(start), ...lc(1), ...lv(start));
        this.bytes.push(OP.CP_GTEQ_32, ...lv(start), ...lc(0), ...lv(valid));
        this.bytes.push(OP.JR_FALSE, ...lv(valid));
        this.addPatch(empty);
        this.bytes.push(OP.CP_LT_32, ...lv(start), ...lv(length), ...lv(valid));
        this.bytes.push(OP.JR_FALSE, ...lv(valid));
        this.addPatch(empty);
        this.bytes.push(OP.SUB_32, ...lv(length), ...lv(start), ...lv(available));
        if (instruction.operation === "Text.GetSubTextToEnd") {
          this.bytes.push(OP.MOVE_32_32, ...lv(available), ...lv(requested));
          this.bytes.push(OP.JR);
          this.addPatch(copy);
        } else {
          this.bytes.push(OP.MOVE_32_32, ...arg(2), ...lv(requested));
          this.bytes.push(OP.CP_GT_32, ...lv(requested), ...lc(0), ...lv(valid));
          this.bytes.push(OP.JR_FALSE, ...lv(valid));
          this.addPatch(empty);
          this.bytes.push(OP.CP_GT_32, ...lv(requested), ...lv(available), ...lv(valid));
          this.bytes.push(OP.JR_FALSE, ...lv(valid));
          this.addPatch(copy);
          this.markLabel(clamp);
          this.bytes.push(OP.MOVE_32_32, ...lv(available), ...lv(requested));
        }
        this.markLabel(copy);
        this.bytes.push(OP.ADD_32, ...lc(buffer), ...lv(start), ...lv(offset));
        this.bytes.push(OP.MOVE_32_32, ...lv(requested), ...lv(size));
        this.bytes.push(
          OP.MEMORY_READ,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(offset),
          ...lv(size),
          ...this.location(target),
        );
        // Copy only the requested characters, then terminate the slice. The
        // next source character need not be NUL when taking a short prefix.
        this.bytes.push(OP.ADD_32, ...lc(target.offset), ...lv(size), ...lv(offset));
        const terminator = this.scratch(1);
        this.bytes.push(OP.MOVE_8_8, ...lc(0), ...lv(terminator));
        this.bytes.push(
          OP.MEMORY_WRITE,
          ...lc(1),
          ...lc(target.scope === "global" ? 0 : this.objectId),
          ...lv(offset),
          ...lc(1),
          ...lv(terminator),
        );
        this.bytes.push(OP.JR);
        this.addPatch(done);
        this.markLabel(empty);
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...lcs(""), ...this.location(target));
        this.markLabel(done);
        return;
      }
      case "Text.ConvertToLowerCase":
      case "Text.ConvertToUpperCase": {
        if (!target) break;
        const source = this.textParameter(instruction.args[0]!);
        if (!source) break;
        const index = this.scratch(4);
        const character = this.scratch(1);
        const numeric = this.scratch(4);
        const isTerminator = this.scratch(1);
        const inRange = this.scratch(1);
        const loop = this.newLabel("text-case-loop");
        const process = this.newLabel("text-case-process");
        const done = this.newLabel("text-case-done");
        const skip = this.newLabel("text-case-skip");
        const lower = instruction.operation === "Text.ConvertToLowerCase";
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...source, ...this.location(target));
        this.bytes.push(OP.MOVE_32_32, ...lc(target.offset - 1), ...lv(index));
        this.markLabel(loop);
        this.bytes.push(OP.ADD_32, ...lv(index), ...lc(1), ...lv(index));
        this.bytes.push(
          OP.MEMORY_READ,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(index),
          ...lc(1),
          ...lv(character),
        );
        this.bytes.push(OP.CP_EQ_8, ...lv(character), ...lc(0), ...lv(isTerminator));
        this.bytes.push(OP.JR_FALSE, ...lv(isTerminator));
        this.addPatch(process);
        this.bytes.push(OP.JR);
        this.addPatch(done);
        this.markLabel(process);
        this.bytes.push(OP.MOVE_8_32, ...lv(character), ...lv(numeric));
        this.bytes.push(OP.CP_GTEQ_32, ...lv(numeric), ...lc(lower ? 65 : 97), ...lv(inRange));
        this.bytes.push(OP.JR_FALSE, ...lv(inRange));
        this.addPatch(skip);
        this.bytes.push(OP.CP_LTEQ_32, ...lv(numeric), ...lc(lower ? 90 : 122), ...lv(inRange));
        this.bytes.push(OP.JR_FALSE, ...lv(inRange));
        this.addPatch(skip);
        this.bytes.push(OP.ADD_8, ...lv(character), ...lc(lower ? 32 : -32), ...lv(character));
        this.bytes.push(
          OP.MEMORY_WRITE,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(index),
          ...lc(1),
          ...lv(character),
        );
        this.markLabel(skip);
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(done);
        return;
      }
      case "EV3File.OpenAppend":
      case "EV3File.OpenRead":
      case "EV3File.OpenWrite": {
        if (!target) break;
        const handle = this.scratch(2);
        const command =
          instruction.operation === "EV3File.OpenAppend"
            ? FILE.OPEN_APPEND
            : instruction.operation === "EV3File.OpenRead"
              ? FILE.OPEN_READ
              : FILE.OPEN_WRITE;
        const filename = this.fileName(instruction.args[0]!);
        if (!filename) break;
        this.bytes.push(OP.FILE, ...lc(command), ...filename, ...lv(handle));
        if (instruction.operation === "EV3File.OpenRead") this.bytes.push(...lv(this.scratch(4)));
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        return;
      }
      case "EV3File.Close":
        this.bytes.push(OP.FILE, ...lc(FILE.CLOSE), ...arg(0));
        return;
      case "EV3File.WriteLine":
        this.bytes.push(OP.FILE, ...lc(FILE.WRITE_TEXT), ...arg(0), ...lc(6), ...arg(1));
        return;
      case "EV3File.ReadLine":
        if (!target) break;
        this.bytes.push(
          OP.FILE,
          ...lc(FILE.READ_TEXT),
          ...arg(0),
          ...lc(6),
          ...lc(64),
          ...this.location(target),
        );
        return;
      case "EV3File.WriteByte": {
        const byte = this.byteParameter(instruction.args[1]!);
        if (!byte) break;
        this.bytes.push(OP.FILE, ...lc(FILE.WRITE_BYTES), ...arg(0), ...lc(1), ...byte);
        return;
      }
      case "EV3File.ReadByte": {
        if (!target) break;
        const text = this.scratch(2);
        this.bytes.push(OP.FILE, ...lc(FILE.READ_TEXT), ...arg(0), ...lc(0), ...lc(1), ...lv(text));
        this.unsignedByte(lv(text), this.location(target));
        return;
      }
      case "EV3File.ConvertToNumber":
        if (!target) break;
        this.bytes.push(
          OP.STRING,
          ...lc(STRING.STRING_TO_VALUE),
          ...arg(0),
          ...this.location(target),
        );
        return;
      case "EV3File.ReadNumberArray": {
        if (!target) break;
        const array = this.scratch(2);
        const offset = this.scratch(4);
        const remaining = this.scratch(4);
        const chunk = this.scratch(4);
        const bytes = this.scratch(2);
        const chunkArray = this.scratch(2);
        const active = this.scratch(1);
        const value = this.scratch(4);
        const destination = this.scratch(4);
        const loop = this.newLabel("file-read-number-array-loop");
        const limited = this.newLabel("file-read-number-array-limited");
        const done = this.newLabel("file-read-number-array-done");
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...arg(1), ...lv(array));
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(offset));
        this.markLabel(loop);
        this.bytes.push(OP.CP_LT_32, ...lv(offset), ...arg(1), ...lv(active));
        this.bytes.push(OP.JR_FALSE, ...lv(active));
        this.addPatch(done);
        this.bytes.push(OP.SUB_32, ...arg(1), ...lv(offset), ...lv(remaining));
        this.bytes.push(OP.MOVE_32_32, ...lv(remaining), ...lv(chunk));
        this.bytes.push(OP.CP_GT_32, ...lv(chunk), ...lc(1000), ...lv(active));
        this.bytes.push(OP.JR_FALSE, ...lv(active));
        this.addPatch(limited);
        this.bytes.push(OP.MOVE_32_32, ...lc(1000), ...lv(chunk));
        this.markLabel(limited);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...lv(chunk), ...lv(chunkArray));
        this.bytes.push(OP.MUL_32, ...lv(chunk), ...lc(4), ...lv(remaining));
        this.bytes.push(OP.MOVE_32_16, ...lv(remaining), ...lv(bytes));
        this.bytes.push(
          OP.FILE,
          ...lc(FILE.READ_BYTES),
          ...arg(0),
          ...lv(bytes),
          ...lh(chunkArray),
        );
        this.arrayLoop(lv(chunk), (index) => {
          this.bytes.push(OP.ARRAY_READ, ...lv(chunkArray), ...lv(index), ...lv(value));
          this.bytes.push(OP.ADD_32, ...lv(offset), ...lv(index), ...lv(destination));
          this.bytes.push(OP.ARRAY_WRITE, ...lv(array), ...lv(destination), ...lv(value));
        });
        this.bytes.push(OP.ADD_32, ...lv(offset), ...lv(chunk), ...lv(offset));
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(done);
        this.bytes.push(OP.MOVE_16_32, ...lv(array), ...this.location(target));
        return;
      }
      case "EV3File.WriteNumberArray": {
        const contents = this.arrayContents(instruction.args[2]!);
        if (!contents) {
          this.diagnostics.push(
            diagnostic(
              "EV32028",
              "EV3File.WriteNumberArray requires a Row or Vector result variable.",
              instruction.span,
            ),
          );
          return;
        }
        const offset = this.scratch(4);
        const remaining = this.scratch(4);
        const chunk = this.scratch(4);
        const bytes = this.scratch(2);
        const chunkArray = this.scratch(2);
        const active = this.scratch(1);
        const value = this.scratch(4);
        const source = this.scratch(4);
        const loop = this.newLabel("file-write-number-array-loop");
        const limited = this.newLabel("file-write-number-array-limited");
        const done = this.newLabel("file-write-number-array-done");
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(offset));
        this.markLabel(loop);
        this.bytes.push(OP.CP_LT_32, ...lv(offset), ...arg(1), ...lv(active));
        this.bytes.push(OP.JR_FALSE, ...lv(active));
        this.addPatch(done);
        this.bytes.push(OP.SUB_32, ...arg(1), ...lv(offset), ...lv(remaining));
        this.bytes.push(OP.MOVE_32_32, ...lv(remaining), ...lv(chunk));
        this.bytes.push(OP.CP_GT_32, ...lv(chunk), ...lc(1000), ...lv(active));
        this.bytes.push(OP.JR_FALSE, ...lv(active));
        this.addPatch(limited);
        this.bytes.push(OP.MOVE_32_32, ...lc(1000), ...lv(chunk));
        this.markLabel(limited);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...lv(chunk), ...lv(chunkArray));
        this.arrayLoop(lv(chunk), (index) => {
          this.bytes.push(OP.ADD_32, ...lv(offset), ...lv(index), ...lv(source));
          this.bytes.push(OP.ARRAY_READ, ...arg(2), ...lv(source), ...lv(value));
          this.bytes.push(OP.ARRAY_WRITE, ...lv(chunkArray), ...lv(index), ...lv(value));
        });
        this.bytes.push(OP.MUL_32, ...lv(chunk), ...lc(4), ...lv(remaining));
        this.bytes.push(OP.MOVE_32_16, ...lv(remaining), ...lv(bytes));
        this.bytes.push(
          OP.FILE,
          ...lc(FILE.WRITE_BYTES),
          ...arg(0),
          ...lv(bytes),
          ...lh(chunkArray),
        );
        this.bytes.push(OP.ADD_32, ...lv(offset), ...lv(chunk), ...lv(offset));
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(done);
        return;
      }
      case "EV3File.TableLookup": {
        if (!target) break;
        const handle = this.scratch(2);
        const offset = this.scratch(4);
        const count = this.scratch(4);
        const active = this.scratch(1);
        const byte = this.scratch(1);
        const loop = this.newLabel("table-lookup");
        const done = this.newLabel("table-lookup-done");
        const filename = this.fileName(instruction.args[0]!);
        if (!filename) break;
        this.bytes.push(
          OP.FILE,
          ...lc(FILE.OPEN_READ),
          ...filename,
          ...lv(handle),
          ...lv(this.scratch(4)),
        );
        this.bytes.push(OP.MUL_32, ...arg(1), ...arg(2), ...lv(offset));
        this.bytes.push(OP.ADD_32, ...lv(offset), ...arg(3), ...lv(offset));
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(count));
        this.bytes.push(OP.MOVE_8_8, ...lc(0), ...lv(byte));
        this.markLabel(loop);
        this.bytes.push(OP.CP_LTEQ_32, ...lv(count), ...lv(offset), ...lv(active));
        this.bytes.push(OP.JR_FALSE, ...lv(active));
        this.addPatch(done);
        this.bytes.push(OP.FILE, ...lc(FILE.READ_BYTES), ...lv(handle), ...lc(1), ...lv(byte));
        this.bytes.push(OP.ADD_32, ...lv(count), ...lc(1), ...lv(count));
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(done);
        this.bytes.push(OP.FILE, ...lc(FILE.CLOSE), ...lv(handle));
        this.unsignedByte(lv(byte), this.location(target));
        return;
      }
      case "Byte.NOT": {
        if (!target) break;
        const value = this.byteParameter(instruction.args[0]!);
        if (!value) break;
        this.byteResult(target, (destination) => {
          this.bytes.push(OP.XOR_8, ...value, ...lc(0xff), ...destination);
        });
        return;
      }
      case "Byte.AND_":
      case "Byte.OR_":
      case "Byte.XOR": {
        if (!target) break;
        const left = this.byteParameter(instruction.args[0]!);
        const right = this.byteParameter(instruction.args[1]!);
        if (!left || !right) break;
        const opcode =
          instruction.operation === "Byte.AND_"
            ? OP.AND_8
            : instruction.operation === "Byte.OR_"
              ? OP.OR_8
              : OP.XOR_8;
        this.byteResult(target, (destination) => {
          this.bytes.push(opcode, ...left, ...right, ...destination);
        });
        return;
      }
      case "Byte.BIT": {
        if (!target) break;
        const value = this.byteParameter(instruction.args[0]!);
        const index = instruction.args[1];
        if (!value || !index) break;
        const indexValue = this.parameter(index);
        if (!indexValue) break;
        const indexInteger = this.scratch(4);
        if (this.typeOf(index)?.kind === "number")
          this.bytes.push(OP.MOVE_F_32, ...indexValue, ...lv(indexInteger));
        else this.bytes.push(OP.MOVE_32_32, ...indexValue, ...lv(indexInteger));
        const shift = this.scratch(1);
        const mask = this.scratch(1);
        const masked = this.scratch(1);
        this.bytes.push(OP.AND_32, ...lv(indexInteger), ...lc(7), ...lv(indexInteger));
        this.bytes.push(OP.MOVE_32_8, ...lv(indexInteger), ...lv(shift));
        // Firmware RL8 is a left shift, despite its "rotate" name.
        this.bytes.push(OP.RL_8, ...lc(1), ...lv(shift), ...lv(mask));
        this.bytes.push(OP.AND_8, ...value, ...lv(mask), ...lv(masked));
        this.byteResult(target, (destination) => {
          this.bytes.push(OP.CP_NEQ_8, ...lv(masked), ...lc(0), ...destination);
        });
        return;
      }
      case "Byte.SHL":
      case "Byte.SHR": {
        if (!target) break;
        const value = this.byteParameter(instruction.args[0]!);
        const distance = this.floatParameter(instruction.args[1]!);
        if (!value || !distance) break;
        const valueInteger = this.scratch(4);
        const valueFloat = this.scratch(4);
        const multiplier = this.scratch(4);
        const result = this.scratch(4);
        this.unsignedByte(value, lv(valueInteger));
        this.bytes.push(OP.MOVE_32_F, ...lv(valueInteger), ...lv(valueFloat));
        this.bytes.push(OP.MATH, ...lc(MATH.POW), ...lcf(2), ...distance, ...lv(multiplier));
        this.bytes.push(
          instruction.operation === "Byte.SHL" ? OP.MUL_F : OP.DIV_F,
          ...lv(valueFloat),
          ...lv(multiplier),
          ...lv(result),
        );
        if (instruction.operation === "Byte.SHR")
          this.bytes.push(OP.MATH, ...lc(MATH.FLOOR), ...lv(result), ...lv(result));
        else this.bytes.push(OP.MATH, ...lc(MATH.MOD), ...lv(result), ...lcf(256), ...lv(result));
        this.bytes.push(OP.MOVE_F_32, ...lv(result), ...this.location(target));
        return;
      }
      case "Byte.ToLogic": {
        if (!target) break;
        const value = this.parameter(instruction.args[0]!);
        if (!value) break;
        if (this.typeOf(instruction.args[0]!)?.kind === "number")
          this.bytes.push(OP.CP_GT_F, ...value, ...lcf(0), ...this.location(target));
        else this.bytes.push(OP.CP_GT_32, ...value, ...lc(0), ...this.location(target));
        return;
      }
      case "Byte.H":
      case "Byte.B":
      case "Byte.L": {
        if (!target) break;
        const source = arg(0);
        const buffer = this.scratch(STRING_BYTES);
        const index = this.scratch(4);
        const character = this.scratch(1);
        const characterNumber = this.scratch(4);
        const value = this.scratch(4);
        const digit = this.scratch(4);
        const inRange = this.scratch(1);
        const loop = this.newLabel("byte-parse-loop");
        const next = this.newLabel("byte-parse-next");
        const done = this.newLabel("byte-parse-done");
        const digitFound = this.newLabel("byte-parse-digit");

        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...source, ...lv(buffer));
        if (instruction.operation === "Byte.L") {
          const process = this.newLabel("byte-logic-process");
          const skip = this.newLabel("byte-logic-skip");
          this.bytes.push(OP.MOVE_32_32, ...lc(buffer - 1), ...lv(index));
          this.markLabel(loop);
          this.bytes.push(OP.ADD_32, ...lv(index), ...lc(1), ...lv(index));
          this.bytes.push(
            OP.MEMORY_READ,
            ...lc(1),
            ...lc(this.objectId),
            ...lv(index),
            ...lc(1),
            ...lv(character),
          );
          this.bytes.push(OP.CP_EQ_8, ...lv(character), ...lc(0), ...lv(inRange));
          this.bytes.push(OP.JR_FALSE, ...lv(inRange));
          this.addPatch(process);
          this.bytes.push(OP.JR);
          this.addPatch(done);
          this.markLabel(process);
          this.bytes.push(OP.MOVE_8_32, ...lv(character), ...lv(characterNumber));
          this.bytes.push(OP.CP_GTEQ_32, ...lv(characterNumber), ...lc(97), ...lv(inRange));
          this.bytes.push(OP.JR_FALSE, ...lv(inRange));
          this.addPatch(skip);
          this.bytes.push(OP.CP_LTEQ_32, ...lv(characterNumber), ...lc(122), ...lv(inRange));
          this.bytes.push(OP.JR_FALSE, ...lv(inRange));
          this.addPatch(skip);
          this.bytes.push(OP.ADD_8, ...lv(character), ...lc(-32), ...lv(character));
          this.bytes.push(
            OP.MEMORY_WRITE,
            ...lc(1),
            ...lc(this.objectId),
            ...lv(index),
            ...lc(1),
            ...lv(character),
          );
          this.markLabel(skip);
          this.bytes.push(OP.JR);
          this.addPatch(loop);
          this.markLabel(done);
          const matched = this.scratch(1);
          this.bytes.push(
            OP.STRING,
            ...lc(STRING.COMPARE),
            ...lv(buffer),
            ...lcs("TRUE"),
            ...lv(matched),
          );
          this.bytes.push(OP.MOVE_8_32, ...lv(matched), ...this.location(target));
          return;
        }

        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(value));
        this.bytes.push(OP.MOVE_32_32, ...lc(buffer - 1), ...lv(index));
        this.markLabel(loop);
        this.bytes.push(OP.ADD_32, ...lv(index), ...lc(1), ...lv(index));
        this.bytes.push(
          OP.MEMORY_READ,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(index),
          ...lc(1),
          ...lv(character),
        );
        this.bytes.push(OP.CP_EQ_8, ...lv(character), ...lc(0), ...lv(inRange));
        this.bytes.push(OP.JR_TRUE, ...lv(inRange));
        this.addPatch(done);
        this.bytes.push(OP.MOVE_8_32, ...lv(character), ...lv(characterNumber));
        this.bytes.push(OP.CP_GTEQ_32, ...lv(characterNumber), ...lc(48), ...lv(inRange));
        this.bytes.push(OP.JR_FALSE, ...lv(inRange));
        this.addPatch(next);
        this.bytes.push(
          OP.CP_LTEQ_32,
          ...lv(characterNumber),
          ...lc(instruction.operation === "Byte.B" ? 49 : 57),
          ...lv(inRange),
        );
        this.bytes.push(OP.JR_FALSE, ...lv(inRange));
        const upper = this.newLabel("byte-parse-upper");
        this.addPatch(instruction.operation === "Byte.B" ? next : upper);
        if (instruction.operation === "Byte.B") {
          this.bytes.push(OP.SUB_32, ...lv(characterNumber), ...lc(48), ...lv(digit));
          this.bytes.push(OP.JR);
          this.addPatch(digitFound);
        } else {
          const lower = this.newLabel("byte-parse-lower");
          this.bytes.push(OP.SUB_32, ...lv(characterNumber), ...lc(48), ...lv(digit));
          this.bytes.push(OP.JR);
          this.addPatch(digitFound);
          this.markLabel(upper);
          this.bytes.push(OP.CP_GTEQ_32, ...lv(characterNumber), ...lc(65), ...lv(inRange));
          this.bytes.push(OP.JR_FALSE, ...lv(inRange));
          this.addPatch(next);
          this.bytes.push(OP.CP_LTEQ_32, ...lv(characterNumber), ...lc(70), ...lv(inRange));
          this.bytes.push(OP.JR_FALSE, ...lv(inRange));
          this.addPatch(lower);
          this.bytes.push(OP.SUB_32, ...lv(characterNumber), ...lc(55), ...lv(digit));
          this.bytes.push(OP.JR);
          this.addPatch(digitFound);
          this.markLabel(lower);
          this.bytes.push(OP.CP_GTEQ_32, ...lv(characterNumber), ...lc(97), ...lv(inRange));
          this.bytes.push(OP.JR_FALSE, ...lv(inRange));
          this.addPatch(next);
          this.bytes.push(OP.CP_LTEQ_32, ...lv(characterNumber), ...lc(102), ...lv(inRange));
          this.bytes.push(OP.JR_FALSE, ...lv(inRange));
          this.addPatch(next);
          this.bytes.push(OP.SUB_32, ...lv(characterNumber), ...lc(87), ...lv(digit));
        }
        this.markLabel(digitFound);
        this.bytes.push(
          OP.MUL_32,
          ...lv(value),
          ...lc(instruction.operation === "Byte.B" ? 2 : 16),
          ...lv(value),
        );
        this.bytes.push(OP.ADD_32, ...lv(value), ...lv(digit), ...lv(value));
        this.markLabel(next);
        this.bytes.push(
          OP.CP_GT_32,
          ...lv(index),
          ...lc(buffer + STRING_BYTES - 2),
          ...lv(inRange),
        );
        this.bytes.push(OP.JR_FALSE, ...lv(inRange));
        this.addPatch(loop);
        this.markLabel(done);
        this.bytes.push(OP.AND_32, ...lv(value), ...lc(255), ...lv(value));
        this.bytes.push(OP.MOVE_32_32, ...lv(value), ...this.location(target));
        return;
      }
      case "Byte.ToHex": {
        if (!target) break;
        const value = this.byteParameter(instruction.args[0]!);
        if (!value) break;
        const number = this.scratch(4);
        this.unsignedByte(value, lv(number));
        this.bytes.push(
          OP.STRING,
          ...lc(STRING.NUMBER_FORMATTED),
          ...lv(number),
          ...lcs("%02X"),
          ...lc(3),
          ...this.location(target),
        );
        return;
      }
      case "Byte.ToBinary": {
        if (!target) break;
        const value = this.byteParameter(instruction.args[0]!);
        if (!value) break;
        this.byteToBinary(value, target);
        return;
      }
      case "Math.Pi":
        if (!target) break;
        this.bytes.push(OP.MOVE_F_F, ...lcf(Math.PI), ...this.location(target));
        return;
      case "Math.GetRandomNumber": {
        if (!target) break;
        const bound = this.wordParameter(instruction.args[0]!);
        if (!bound) break;
        const result = this.scratch(2);
        this.bytes.push(OP.RANDOM, ...lc(1), ...bound, ...lv(result));
        this.bytes.push(OP.MOVE_16_32, ...lv(result), ...this.location(target));
        return;
      }
      case "Math.DoubleToDecimal": {
        if (!target) break;
        const source = floatArg(0);
        if (!source) break;
        this.bytes.push(OP.MOVE_F_F, ...source, ...this.location(target));
        return;
      }
      case "Math.GetDegrees":
      case "Math.GetRadians": {
        if (!target) break;
        const source = floatArg(0);
        if (!source) break;
        this.bytes.push(
          OP.MUL_F,
          ...source,
          ...lcf(instruction.operation === "Math.GetDegrees" ? 180 / Math.PI : Math.PI / 180),
          ...this.location(target),
        );
        return;
      }
      case "Math.Max":
      case "Math.Min": {
        if (!target) break;
        const left = floatArg(0);
        const right = floatArg(1);
        if (!left || !right) break;
        const difference = this.scratch(4);
        const absolute = this.scratch(4);
        const sum = this.scratch(4);
        this.bytes.push(OP.SUB_F, ...left, ...right, ...lv(difference));
        this.bytes.push(OP.MATH, ...lc(MATH.ABS), ...lv(difference), ...lv(absolute));
        this.bytes.push(OP.ADD_F, ...left, ...right, ...lv(sum));
        this.bytes.push(
          instruction.operation === "Math.Max" ? OP.ADD_F : OP.SUB_F,
          ...lv(sum),
          ...lv(absolute),
          ...this.location(target),
        );
        this.bytes.push(OP.DIV_F, ...this.location(target), ...lcf(2), ...this.location(target));
        return;
      }
      case "Math.Abs":
      case "Math.Ceiling":
      case "Math.Floor":
      case "Math.NaturalLog":
      case "Math.Log":
      case "Math.Cos":
      case "Math.Sin":
      case "Math.Tan":
      case "Math.ArcSin":
      case "Math.ArcCos":
      case "Math.ArcTan":
      case "Math.SquareRoot":
      case "Math.Round": {
        if (!target) break;
        let source = floatArg(0);
        if (!source) break;
        if (["Math.Sin", "Math.Cos", "Math.Tan"].includes(instruction.operation)) {
          const degrees = this.scratch(4);
          this.bytes.push(OP.MUL_F, ...source, ...lcf(180 / Math.PI), ...lv(degrees));
          source = lv(degrees);
        }
        const command: Partial<Record<typeof instruction.operation, number>> = {
          "Math.Abs": MATH.ABS,
          "Math.Ceiling": MATH.CEIL,
          "Math.Floor": MATH.FLOOR,
          "Math.NaturalLog": MATH.LN,
          "Math.Log": MATH.LOG,
          "Math.Cos": MATH.COS,
          "Math.Sin": MATH.SIN,
          "Math.Tan": MATH.TAN,
          "Math.ArcSin": MATH.ASIN,
          "Math.ArcCos": MATH.ACOS,
          "Math.ArcTan": MATH.ATAN,
          "Math.SquareRoot": MATH.SQRT,
          "Math.Round": MATH.ROUND,
        };
        this.bytes.push(
          OP.MATH,
          ...lc(command[instruction.operation]!),
          ...source,
          ...this.location(target),
        );
        if (["Math.ArcSin", "Math.ArcCos", "Math.ArcTan"].includes(instruction.operation))
          this.bytes.push(
            OP.MUL_F,
            ...this.location(target),
            ...lcf(Math.PI / 180),
            ...this.location(target),
          );
        return;
      }
      case "Math.Power":
      case "Math.Remainder": {
        if (!target) break;
        const left = floatArg(0);
        const right = floatArg(1);
        if (!left || !right) break;
        this.bytes.push(
          OP.MATH,
          ...lc(instruction.operation === "Math.Power" ? MATH.POW : MATH.MOD),
          ...left,
          ...right,
          ...this.location(target),
        );
        return;
      }
      case "EV3.Time":
        if (!target) break;
        this.bytes.push(OP.TIMER_READ, ...this.location(target));
        return;
      case "EV3.BatteryLevel":
        if (!target) break;
        this.bytes.push(OP.UI_READ, ...lc(UI_READ.GET_LBATT), ...this.location(target));
        return;
      case "EV3.BatteryVoltage":
        if (!target) break;
        this.bytes.push(OP.UI_READ, ...lc(UI_READ.GET_VBATT), ...this.location(target));
        return;
      case "EV3.BatteryCurrent":
        if (!target) break;
        this.bytes.push(OP.UI_READ, ...lc(UI_READ.GET_IBATT), ...this.location(target));
        return;
      case "EV3.BrickName":
        if (!target) break;
        this.bytes.push(OP.COM_GET, ...lc(COM_GET.BRICK_NAME), ...lc(18), ...this.location(target));
        return;
      case "EV3.SetLEDColor": {
        const pattern = ledPattern(instruction.args[0]!, instruction.args[1]!);
        if (pattern === undefined) {
          this.diagnostics.push(
            diagnostic(
              "EV32015",
              "EV3.SetLEDColor requires supported constant color and effect names.",
              instruction.span,
            ),
          );
          return;
        }
        this.bytes.push(OP.UI_WRITE, ...lc(UI_WRITE.LED), ...lc(pattern));
        return;
      }
      case "EV3.SystemCall":
        if (!target) break;
        this.bytes.push(OP.SYSTEM, ...arg(0), ...this.location(target));
        return;
      case "EV3.QueueNextCommand":
        // Queuing only affects the desktop-to-brick transport path. RBF programs already execute locally.
        return;
      case "LCD.Clear":
        this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.CLEAN));
        this.lcdAutoUpdate();
        return;
      case "LCD.Update":
        if (this.hasLcdUpdateControl) this.bytes.push(OP.MOVE_32_32, ...lc(0), ...gv(4));
        this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.UPDATE));
        return;
      case "LCD.StopUpdate":
        this.bytes.push(OP.MOVE_32_32, ...lc(1), ...gv(4));
        return;
      case "LCD.Text":
        this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.SELECT_FONT), ...arg(3));
        if (this.typeOf(instruction.args[4]!)?.kind !== "string") {
          const sourceType = this.typeOf(instruction.args[4]!)?.kind;
          const value = sourceType === "integer" ? this.scratch(4) : undefined;
          if (value !== undefined) this.bytes.push(OP.MOVE_32_F, ...arg(4), ...lv(value));
          this.bytes.push(
            OP.UI_DRAW,
            ...lc(UI_DRAW.VALUE),
            ...arg(0),
            ...arg(1),
            ...arg(2),
            ...(value === undefined ? arg(4) : lv(value)),
            ...lc(7),
            ...lc(0),
          );
          this.lcdAutoUpdate();
          return;
        }
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.TEXT),
          ...arg(0),
          ...arg(1),
          ...arg(2),
          ...arg(4),
        );
        this.lcdAutoUpdate();
        return;
      case "LCD.Pixel":
        this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.PIXEL), ...arg(0), ...arg(1), ...arg(2));
        this.lcdAutoUpdate();
        return;
      case "LCD.FillRect":
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.FILLRECT),
          ...arg(0),
          ...arg(1),
          ...arg(2),
          ...arg(3),
          ...arg(4),
        );
        this.lcdAutoUpdate();
        return;
      case "LCD.Rect":
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.RECT),
          ...arg(0),
          ...arg(1),
          ...arg(2),
          ...arg(3),
          ...arg(4),
        );
        this.lcdAutoUpdate();
        return;
      case "LCD.InverseRect":
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.INVERSERECT),
          ...arg(0),
          ...arg(1),
          ...arg(2),
          ...arg(3),
        );
        this.lcdAutoUpdate();
        return;
      case "LCD.FillCircle":
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.FILLCIRCLE),
          ...arg(0),
          ...arg(1),
          ...arg(2),
          ...arg(3),
        );
        this.lcdAutoUpdate();
        return;
      case "LCD.BmpFile":
        {
          const file = this.mediaFileName(instruction.args[3]!, ".rgf");
          if (!file) break;
          this.bytes.push(
            OP.UI_DRAW,
            ...lc(UI_DRAW.BMPFILE),
            ...arg(0),
            ...arg(1),
            ...arg(2),
            ...file,
          );
        }
        this.lcdAutoUpdate();
        return;
      case "LCD.Value":
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.VALUE),
          ...arg(0),
          ...arg(1),
          ...arg(2),
          ...arg(3),
          ...arg(4),
          ...arg(5),
        );
        this.lcdAutoUpdate();
        return;
      case "LCD.Write":
        {
          const text = this.textParameter(instruction.args[2]!);
          if (!text) break;
          this.bytes.push(OP.UI_DRAW, ...lc(UI_DRAW.TEXT), ...lc(1), ...arg(0), ...arg(1), ...text);
        }
        this.lcdAutoUpdate();
        return;
      case "LCD.Line":
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.LINE),
          ...arg(0),
          ...arg(1),
          ...arg(2),
          ...arg(3),
          ...arg(4),
        );
        this.lcdAutoUpdate();
        return;
      case "LCD.Circle": {
        const values = instruction.args.map((value) => this.integerParameter(value));
        if (values.some((value) => !value)) break;
        this.bytes.push(
          OP.UI_DRAW,
          ...lc(UI_DRAW.CIRCLE),
          ...values[0]!,
          ...values[1]!,
          ...values[2]!,
          ...values[3]!,
        );
        this.lcdAutoUpdate();
        return;
      }
      case "Speaker.Tone": {
        const values = instruction.args.map((value) => this.integerParameter(value));
        if (values.some((value) => !value)) break;
        this.bytes.push(OP.SOUND, ...lc(SOUND.TONE), ...values[0]!, ...values[1]!, ...values[2]!);
        return;
      }
      case "Speaker.Play":
        {
          // SOUND.PLAY resolves the program resource path and appends .rsf itself.
          const file = this.parameter(instruction.args[1]!);
          if (!file) break;
          this.bytes.push(OP.SOUND, ...lc(SOUND.PLAY), ...arg(0), ...file);
        }
        return;
      case "Speaker.Stop":
        this.bytes.push(OP.SOUND, ...lc(SOUND.BREAK));
        return;
      case "Speaker.Note": {
        const volume = this.byteParameter(instruction.args[0]!);
        const note = this.parameter(instruction.args[1]!);
        const duration = this.wordParameter(instruction.args[2]!);
        if (!volume || !note || !duration) break;
        const frequency = this.scratch(2);
        this.bytes.push(OP.NOTE_TO_FREQ, ...note, ...lv(frequency));
        this.bytes.push(OP.SOUND, ...lc(SOUND.TONE), ...volume, ...lv(frequency), ...duration);
        return;
      }
      case "Speaker.IsBusy":
        if (!target) break;
        this.bytes.push(OP.SOUND_TEST, ...this.location(target));
        return;
      case "Speaker.Wait":
        this.bytes.push(OP.SOUND_READY);
        return;
      case "Buttons.Wait":
        this.bytes.push(OP.UI_BUTTON, ...lc(UI_BUTTON.WAIT_FOR_PRESS));
        return;
      case "Buttons.Flush":
        this.bytes.push(OP.UI_BUTTON, ...lc(UI_BUTTON.FLUSH));
        return;
      case "Buttons.GetClicks":
        if (!target) break;
        this.buttonText(target, UI_BUTTON.SHORTPRESS);
        return;
      case "Buttons.Current":
        if (!target) break;
        this.buttonText(target, UI_BUTTON.PRESSED);
        return;
      case "Button.IsPressed": {
        if (!target) break;
        const button = buttonCode(instruction.args[0]!);
        if (button === undefined) {
          this.diagnostics.push(
            diagnostic(
              "EV32020",
              "Button.IsPressed requires a supported constant button name.",
              instruction.span,
            ),
          );
          return;
        }
        this.bytes.push(
          OP.UI_BUTTON,
          ...lc(UI_BUTTON.PRESSED),
          ...lc(button),
          ...this.location(target),
        );
        return;
      }
      case "Program.End":
        this.bytes.push(OP.PROGRAM_STOP, ...lc(-1));
        return;
      case "Program.ArgumentCount":
        if (!target) break;
        // Native RBF launch does not carry a command-line argument vector.
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...this.location(target));
        return;
      case "Program.GetArgument":
        if (!target) break;
        this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...lcs(""), ...this.location(target));
        return;
      case "Program.Directory":
        if (!target) break;
        this.bytes.push(
          OP.FILENAME,
          ...lc(FILENAME.GET_FOLDERNAME),
          ...lc(127),
          ...this.location(target),
        );
        return;
      case "Thread.Yield": {
        this.bytes.push(OP.SLEEP);
        return;
      }
      case "Thread.CreateMutex": {
        if (!target) break;
        const index = this.scratch(4);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.SIZE), ...gv(0), ...lv(index));
        this.bytes.push(OP.ARRAY_APPEND, ...gv(0), ...lc(0));
        this.bytes.push(OP.MOVE_32_32, ...lv(index), ...this.location(target));
        return;
      }
      case "Thread.Lock": {
        const acquired = this.scratch(1);
        const loop = this.newLabel("thread-lock");
        const done = this.newLabel("thread-lock-done");
        this.markLabel(loop);
        // A shared SUBCALL serializes the read/test/write even when the VM
        // preempts between instructions. Busy callers retry in the firmware.
        this.bytes.push(OP.CALL, ...lc(this.mutexObjectId), ...lc(2), ...arg(0), ...lv(acquired));
        this.bytes.push(OP.JR_TRUE, ...lv(acquired));
        this.addPatch(done);
        this.bytes.push(OP.SLEEP, OP.JR);
        this.addPatch(loop);
        this.markLabel(done);
        return;
      }
      case "Thread.Unlock":
        this.bytes.push(OP.ARRAY_WRITE, ...gv(0), ...arg(0), ...lc(0));
        return;
      case "Program.Delay": {
        const scratch = this.scratch(4);
        this.bytes.push(OP.TIMER_WAIT, ...arg(0), ...lv(scratch), OP.TIMER_READY, ...lv(scratch));
        return;
      }
      case "Motor.Start": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(
          OP.OUTPUT_SPEED,
          ...motor.layer,
          ...motor.mask,
          ...arg(1),
          OP.OUTPUT_START,
          ...motor.layer,
          ...motor.mask,
        );
        return;
      }
      case "Motor.StartPower": {
        const mask = motorMask(instruction.args[0]!);
        if (!mask) break;
        this.bytes.push(
          OP.OUTPUT_POWER,
          ...lc(0),
          ...lc(mask),
          ...arg(1),
          OP.OUTPUT_START,
          ...lc(0),
          ...lc(mask),
        );
        return;
      }
      case "Motor.StartSteer": {
        const mask = motorMask(instruction.args[0]!);
        if (!mask) break;
        this.bytes.push(
          OP.OUTPUT_STEP_SYNC,
          ...lc(0),
          ...lc(mask),
          ...arg(1),
          ...arg(2),
          ...lc(0),
          ...lc(0),
        );
        return;
      }
      case "Motor.StartSync": {
        const mask = motorMask(instruction.args[0]!);
        if (!mask) break;
        const values = this.motorSyncParameters(instruction.args[1]!, instruction.args[2]!);
        if (!values) break;
        this.bytes.push(
          OP.OUTPUT_STEP_SYNC,
          ...lc(0),
          ...lc(mask),
          ...values.speed,
          ...values.turn,
          ...lc(0),
          ...lc(0),
        );
        return;
      }
      case "Motor.Stop": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(OP.OUTPUT_STOP, ...motor.layer, ...motor.mask, ...arg(1));
        return;
      }
      case "Motor.Move": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(
          OP.OUTPUT_STEP_SPEED,
          ...motor.layer,
          ...motor.mask,
          ...arg(1),
          ...lc(0),
          ...arg(2),
          ...lc(0),
          ...arg(3),
        );
        this.bytes.push(OP.OUTPUT_READY, ...motor.layer, ...motor.mask);
        return;
      }
      case "Motor.MovePower": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(
          OP.OUTPUT_STEP_POWER,
          ...motor.layer,
          ...motor.mask,
          ...arg(1),
          ...lc(0),
          ...arg(2),
          ...lc(0),
          ...arg(3),
          OP.OUTPUT_READY,
          ...motor.layer,
          ...motor.mask,
        );
        return;
      }
      case "Motor.Schedule":
      case "Motor.SchedulePower": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(
          instruction.operation === "Motor.Schedule" ? OP.OUTPUT_STEP_SPEED : OP.OUTPUT_STEP_POWER,
          ...motor.layer,
          ...motor.mask,
          ...arg(1),
          ...arg(2),
          ...arg(3),
          ...arg(4),
          ...arg(5),
        );
        return;
      }
      case "Motor.ResetCount": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(OP.OUTPUT_CLR_COUNT, ...motor.layer, ...motor.mask);
        return;
      }
      case "Motor.ScheduleSteer":
      case "Motor.MoveSteer": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(
          OP.OUTPUT_STEP_SYNC,
          ...motor.layer,
          ...motor.mask,
          ...arg(1),
          ...arg(2),
          ...arg(3),
          ...arg(4),
        );
        if (instruction.operation === "Motor.MoveSteer")
          this.bytes.push(OP.OUTPUT_READY, ...motor.layer, ...motor.mask);
        return;
      }
      case "Motor.ScheduleSync":
      case "Motor.MoveSync": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        const values = this.motorSyncParameters(instruction.args[1]!, instruction.args[2]!);
        if (!values) break;
        this.bytes.push(
          OP.OUTPUT_STEP_SYNC,
          ...motor.layer,
          ...motor.mask,
          ...values.speed,
          ...values.turn,
          ...arg(3),
          ...arg(4),
        );
        if (instruction.operation === "Motor.MoveSync")
          this.bytes.push(OP.OUTPUT_READY, ...motor.layer, ...motor.mask);
        return;
      }
      case "Motor.IsBusy": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor || !target) break;
        this.bytes.push(OP.OUTPUT_TEST, ...motor.layer, ...motor.mask, ...this.location(target));
        return;
      }
      case "Motor.Wait": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(OP.OUTPUT_READY, ...motor.layer, ...motor.mask);
        return;
      }
      case "Motor.Invert": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor) break;
        this.bytes.push(OP.OUTPUT_POLARITY, ...motor.layer, ...motor.mask, ...lc(0));
        return;
      }
      case "Motor.GetCount": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor || !target) break;
        this.bytes.push(
          OP.OUTPUT_GET_COUNT,
          ...motor.layer,
          ...motor.port,
          ...this.location(target),
        );
        return;
      }
      case "Motor.GetSpeed": {
        const motor = this.motorAddress(instruction.args[0]!);
        if (!motor || !target) break;
        const speed = this.scratch(1);
        const tacho = this.scratch(4);
        this.bytes.push(OP.OUTPUT_READ, ...motor.layer, ...motor.port, ...lv(speed), ...lv(tacho));
        this.bytes.push(OP.MOVE_8_32, ...lv(speed), ...this.location(target));
        return;
      }
      case "Sensor.GetName": {
        if (!target) break;
        const sensor = this.sensorAddress(instruction.args[0]!);
        if (!sensor) break;
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.GET_NAME),
          ...sensor.layer,
          ...sensor.port,
          ...lc(32),
          ...this.location(target),
        );
        this.bytes.push(
          OP.STRING,
          ...lc(STRING.STRIP),
          ...this.location(target),
          ...this.location(target),
        );
        return;
      }
      case "Sensor.GetType":
      case "Sensor.GetMode": {
        if (!target) break;
        const sensor = this.sensorAddress(instruction.args[0]!);
        if (!sensor) break;
        const type = this.scratch(1);
        const mode = this.scratch(1);
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.GET_TYPEMODE),
          ...sensor.layer,
          ...sensor.port,
          ...lv(type),
          ...lv(mode),
        );
        this.bytes.push(
          OP.MOVE_8_32,
          ...lv(instruction.operation === "Sensor.GetType" ? type : mode),
          ...this.location(target),
        );
        return;
      }
      case "Sensor.IsBusy": {
        if (!target) break;
        const sensor = this.sensorAddress(instruction.args[0]!);
        if (!sensor) break;
        this.byteResult(target, (destination) =>
          this.bytes.push(OP.INPUT_TEST, ...sensor.layer, ...sensor.port, ...destination),
        );
        return;
      }
      case "Sensor.ReadPercent": {
        if (!target) break;
        const sensor = this.sensorAddress(instruction.args[0]!);
        if (!sensor) {
          this.diagnostics.push(
            diagnostic("EV32011", "Sensor port must be between 1 and 16.", instruction.span),
          );
          return;
        }
        const percent = this.scratch(1);
        const nonnegative = this.scratch(1);
        const negative = this.newLabel("sensor-percent-negative");
        const done = this.newLabel("sensor-percent-done");
        this.bytes.push(
          OP.INPUT_READ,
          ...sensor.layer,
          ...sensor.port,
          ...lc(0),
          ...lc(-1),
          ...lv(percent),
        );
        this.bytes.push(OP.MOVE_8_32, ...lv(percent), ...this.location(target));
        this.bytes.push(OP.CP_GTEQ_32, ...this.location(target), ...lc(0), ...lv(nonnegative));
        this.bytes.push(OP.JR_FALSE, ...lv(nonnegative));
        this.addPatch(negative);
        this.bytes.push(OP.JR);
        this.addPatch(done);
        this.markLabel(negative);
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...this.location(target));
        this.markLabel(done);
        return;
      }
      case "Sensor.ReadRaw": {
        if (!target) break;
        const sensor = this.sensorAddress(instruction.args[0]!);
        if (!sensor) return;
        const values = arg(1);
        const raw = this.scratch(32);
        const handle = this.scratch(2);
        this.bytes.push(
          OP.INPUT_READ_EXT,
          ...sensor.layer,
          ...sensor.port,
          ...lc(0),
          ...lc(-1),
          ...lc(18),
          ...lc(8),
          ...lv(raw),
          ...lv(raw + 4),
          ...lv(raw + 8),
          ...lv(raw + 12),
          ...lv(raw + 16),
          ...lv(raw + 20),
          ...lv(raw + 24),
          ...lv(raw + 28),
        );
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_F), ...values, ...lv(handle));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.FILL), ...lv(handle), ...lcf(0));
        const index = this.scratch(4);
        const active = this.scratch(1);
        const withinData = this.scratch(1);
        const offset = this.scratch(4);
        const rawValue = this.scratch(4);
        const value = this.scratch(4);
        const loop = this.newLabel("sensor-raw-loop");
        const noData = this.newLabel("sensor-raw-no-data");
        const write = this.newLabel("sensor-raw-write");
        const done = this.newLabel("sensor-raw-done");
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...lv(index));
        this.markLabel(loop);
        this.bytes.push(OP.CP_LT_32, ...lv(index), ...values, ...lv(active));
        this.bytes.push(OP.JR_FALSE, ...lv(active));
        this.addPatch(done);
        this.bytes.push(OP.CP_LT_32, ...lv(index), ...lc(8), ...lv(withinData));
        this.bytes.push(OP.JR_FALSE, ...lv(withinData));
        this.addPatch(noData);
        this.bytes.push(OP.MUL_32, ...lv(index), ...lc(4), ...lv(offset));
        this.bytes.push(OP.ADD_32, ...lv(offset), ...lc(raw), ...lv(offset));
        this.bytes.push(
          OP.MEMORY_READ,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(offset),
          ...lc(4),
          ...lv(rawValue),
        );
        this.bytes.push(OP.CP_NEQ_32, ...lv(rawValue), ...lc(-2147483648), ...lv(withinData));
        this.bytes.push(OP.JR_FALSE, ...lv(withinData));
        this.addPatch(noData);
        this.bytes.push(OP.MOVE_32_F, ...lv(rawValue), ...lv(value));
        this.bytes.push(OP.JR);
        this.addPatch(write);
        this.markLabel(noData);
        this.bytes.push(OP.MOVE_F_F, ...lcf(0), ...lv(value));
        this.markLabel(write);
        this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lv(index), ...lv(value));
        this.bytes.push(OP.ADD_32, ...lv(index), ...lc(1), ...lv(index));
        this.bytes.push(OP.JR);
        this.addPatch(loop);
        this.markLabel(done);
        this.bytes.push(OP.MOVE_16_32, ...lv(handle), ...this.location(target));
        this.retainCallLocalArray(lv(handle), target);
        return;
      }
      case "Sensor.ReadRawValue": {
        if (!target) break;
        const sensor = this.sensorAddress(instruction.args[0]!);
        const index = instruction.args[1];
        if (!sensor || !index || !["integer", "number"].includes(this.typeOf(index)?.kind ?? "")) {
          this.diagnostics.push(
            diagnostic("EV32012", "Sensor port and value index must be numeric.", instruction.span),
          );
          return;
        }
        const raw = this.scratch(32);
        const valid = this.scratch(1);
        const offset = this.scratch(4);
        const result = this.scratch(4);
        const done = this.newLabel("sensor-raw-value-done");
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.READY_RAW),
          ...sensor.layer,
          ...sensor.port,
          ...lc(0),
          ...lc(-1),
          ...lc(8),
          ...lv(raw),
          ...lv(raw + 4),
          ...lv(raw + 8),
          ...lv(raw + 12),
          ...lv(raw + 16),
          ...lv(raw + 20),
          ...lv(raw + 24),
          ...lv(raw + 28),
        );
        const requested = this.parameter(index);
        if (!requested) break;
        this.bytes.push(OP.MOVE_32_32, ...lc(0), ...this.location(target));
        this.bytes.push(OP.CP_GTEQ_32, ...requested, ...lc(0), ...lv(valid));
        this.bytes.push(OP.JR_FALSE, ...lv(valid));
        this.addPatch(done);
        this.bytes.push(OP.CP_LT_32, ...requested, ...lc(8), ...lv(valid));
        this.bytes.push(OP.JR_FALSE, ...lv(valid));
        this.addPatch(done);
        this.bytes.push(OP.MUL_32, ...requested, ...lc(4), ...lv(offset));
        this.bytes.push(OP.ADD_32, ...lv(offset), ...lc(raw), ...lv(offset));
        this.bytes.push(
          OP.MEMORY_READ,
          ...lc(1),
          ...lc(this.objectId),
          ...lv(offset),
          ...lc(4),
          ...lv(result),
        );
        this.bytes.push(OP.MOVE_32_32, ...lv(result), ...this.location(target));
        this.markLabel(done);
        return;
      }
      case "Sensor1.Raw1":
      case "Sensor2.Raw1":
      case "Sensor3.Raw1":
      case "Sensor4.Raw1": {
        if (!target) break;
        const port = Number(instruction.operation[6]) - 1;
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.READY_RAW),
          ...lc(0),
          ...lc(port),
          ...lc(0),
          ...lc(-1),
          ...lc(1),
          ...this.location(target),
        );
        return;
      }
      case "Sensor1.Raw3":
      case "Sensor2.Raw3":
      case "Sensor3.Raw3":
      case "Sensor4.Raw3": {
        const outputs = instruction.args.map((value) =>
          value.kind === "variable" ? this.allocationFor(value.name) : undefined,
        );
        if (
          outputs.length !== 3 ||
          outputs.some((output) => !output || !["integer", "number"].includes(output.type.kind))
        ) {
          this.diagnostics.push(
            diagnostic(
              "EV32026",
              "Sensor.Raw3 requires three numeric variables to receive its values.",
              instruction.span,
            ),
          );
          return;
        }
        const port = Number(instruction.operation[6]) - 1;
        const raw = [this.scratch(4), this.scratch(4), this.scratch(4)];
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.READY_RAW),
          ...lc(0),
          ...lc(port),
          ...lc(0),
          ...lc(-1),
          ...lc(3),
          ...lv(raw[0]!),
          ...lv(raw[1]!),
          ...lv(raw[2]!),
        );
        for (const [index, output] of outputs.entries()) {
          this.bytes.push(
            output!.type.kind === "number" ? OP.MOVE_32_F : OP.MOVE_32_32,
            ...lv(raw[index]!),
            ...this.location(output!),
          );
        }
        return;
      }
      case "Sensor.SetMode": {
        const sensor = this.sensorAddress(instruction.args[0]!);
        const mode = instruction.args[1];
        if (!sensor || !mode || !["integer", "number"].includes(this.typeOf(mode)?.kind ?? "")) {
          this.diagnostics.push(
            diagnostic("EV32012", "Sensor port and mode must be numeric.", instruction.span),
          );
          return;
        }
        const modeByte = this.byteParameter(mode);
        if (!modeByte) break;
        const scratch = this.scratch(4);
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.READY_RAW),
          ...sensor.layer,
          ...sensor.port,
          ...lc(0),
          ...modeByte,
          ...lc(1),
          ...lv(scratch),
        );
        return;
      }
      case "Sensor.Wait": {
        const sensor = this.sensorAddress(instruction.args[0]!);
        if (!sensor) break;
        this.bytes.push(OP.INPUT_READY, ...sensor.layer, ...sensor.port);
        return;
      }
      case "Sensor.CommunicateI2C":
      case "Sensor.ReadI2CRegisters":
      case "Sensor.ReadI2CRegister": {
        if (!target) break;
        const sensor = this.sensorAddress(instruction.args[0]!);
        const readBytes =
          instruction.operation === "Sensor.ReadI2CRegister"
            ? 1
            : this.fixedSensorByteCount(
                instruction.args[instruction.operation === "Sensor.CommunicateI2C" ? 3 : 3],
                32,
                "I2C read byte count",
                instruction,
              );
        const writeBytes =
          instruction.operation === "Sensor.CommunicateI2C"
            ? this.fixedSensorByteCount(
                instruction.args[2],
                31,
                "I2C write byte count",
                instruction,
              )
            : 1;
        if (!sensor || readBytes === undefined || writeBytes === undefined || readBytes < 1) {
          if (readBytes === 0)
            this.diagnostics.push(
              diagnostic("EV32027", "I2C reads request at least one byte.", instruction.span),
            );
          return;
        }
        const address = this.byteParameter(instruction.args[1]!);
        if (!address) break;
        const payload =
          instruction.operation === "Sensor.CommunicateI2C"
            ? this.copyRowToByteArray(instruction.args[4]!, writeBytes)
            : undefined;
        if (instruction.operation === "Sensor.CommunicateI2C" && payload === undefined) break;
        const writeHandle = this.scratch(2);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_8), ...lc(writeBytes + 1), ...lv(writeHandle));
        this.bytes.push(OP.ARRAY_WRITE, ...lv(writeHandle), ...lc(0), ...address);
        if (instruction.operation === "Sensor.CommunicateI2C") {
          for (let index = 0; index < writeBytes; index += 1) {
            const byte = this.scratch(1);
            this.bytes.push(OP.ARRAY_READ, ...lv(payload!), ...lc(index), ...lv(byte));
            this.bytes.push(OP.ARRAY_WRITE, ...lv(writeHandle), ...lc(index + 1), ...lv(byte));
          }
        } else {
          const register = this.byteParameter(instruction.args[2]!);
          if (!register) break;
          this.bytes.push(OP.ARRAY_WRITE, ...lv(writeHandle), ...lc(1), ...register);
        }
        const readHandle = this.scratch(2);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_8), ...lc(readBytes), ...lv(readHandle));
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.SETUP),
          ...sensor.layer,
          ...sensor.port,
          ...lc(1),
          ...lc(0),
          ...lc(writeBytes + 1),
          ...lh(writeHandle),
          ...lc(readBytes),
          ...lh(readHandle),
        );
        if (instruction.operation === "Sensor.ReadI2CRegister") {
          const value = this.scratch(1);
          this.bytes.push(OP.ARRAY_READ, ...lv(readHandle), ...lc(0), ...lv(value));
          this.unsignedByte(lv(value), this.location(target));
        } else this.i2cResultArray(readHandle, readBytes, target);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(writeHandle));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(readHandle));
        if (payload !== undefined) this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(payload));
        return;
      }
      case "Sensor.WriteI2CRegister":
      case "Sensor.WriteI2CRegisters": {
        const sensor = this.sensorAddress(instruction.args[0]!);
        const writeBytes =
          instruction.operation === "Sensor.WriteI2CRegister"
            ? 1
            : this.fixedSensorByteCount(
                instruction.args[3],
                30,
                "I2C write byte count",
                instruction,
              );
        if (!sensor || writeBytes === undefined) return;
        const payload =
          instruction.operation === "Sensor.WriteI2CRegister"
            ? undefined
            : this.copyRowToByteArray(instruction.args[4]!, writeBytes);
        if (instruction.operation === "Sensor.WriteI2CRegisters" && payload === undefined) break;
        const handle = this.scratch(2);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_8), ...lc(writeBytes + 2), ...lv(handle));
        const address = this.byteParameter(instruction.args[1]!);
        if (!address) break;
        this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lc(0), ...address);
        const register = this.byteParameter(instruction.args[2]!);
        if (!register) break;
        this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lc(1), ...register);
        if (instruction.operation === "Sensor.WriteI2CRegister") {
          const value = this.byteParameter(instruction.args[3]!);
          if (!value) break;
          this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lc(2), ...value);
        } else {
          for (let index = 0; index < writeBytes; index += 1) {
            const byte = this.scratch(1);
            this.bytes.push(OP.ARRAY_READ, ...lv(payload!), ...lc(index), ...lv(byte));
            this.bytes.push(OP.ARRAY_WRITE, ...lv(handle), ...lc(index + 2), ...lv(byte));
          }
        }
        const reply = this.scratch(2);
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.CREATE_8), ...lc(0), ...lv(reply));
        this.bytes.push(
          OP.INPUT_DEVICE,
          ...lc(INPUT_DEVICE.SETUP),
          ...sensor.layer,
          ...sensor.port,
          ...lc(1),
          ...lc(0),
          ...lc(writeBytes + 2),
          ...lh(handle),
          ...lc(0),
          ...lh(reply),
        );
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(handle));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(reply));
        if (payload !== undefined) this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(payload));
        return;
      }
      case "Sensor.SendUARTData": {
        const sensor = this.sensorAddress(instruction.args[0]!);
        const bytes = this.fixedSensorByteCount(
          instruction.args[1],
          32,
          "UART write byte count",
          instruction,
        );
        if (!sensor || bytes === undefined || bytes === 0) return;
        const data = this.copyRowToByteArray(instruction.args[2]!, bytes);
        if (data === undefined) break;
        this.bytes.push(OP.INPUT_WRITE, ...sensor.layer, ...sensor.port, ...lc(bytes), ...lh(data));
        this.bytes.push(OP.ARRAY, ...lc(ARRAY.DELETE), ...lv(data));
        return;
      }
    }
    this.diagnostics.push(
      diagnostic(
        "EV32010",
        `EV3 operation '${instruction.operation}' is catalogued but not lowered yet.`,
        instruction.span,
      ),
    );
  }

  private jump(target: Label, next: Label): void {
    if (this.optimize && target === next) return;
    this.bytes.push(OP.JR);
    this.addPatch(target);
  }

  private terminator(block: IRBasicBlock, next: Label): void {
    const terminator = block.terminator;
    if (terminator.op === "stop") {
      this.jump(OBJECT_EPILOGUE, next);
      return;
    }
    if (terminator.op === "return") {
      if (terminator.value) {
        const result = this.allocations.get("$return");
        if (!result) {
          this.diagnostics.push(
            diagnostic("EV32004", "Unable to encode the function return value.", terminator.span),
          );
          return;
        }
        if (result.type.kind === "string") {
          const value = this.parameter(terminator.value);
          if (!value) {
            this.diagnostics.push(
              diagnostic("EV32004", "Unable to encode the function return value.", terminator.span),
            );
            return;
          }
          this.bytes.push(OP.STRING, ...lc(STRING.DUPLICATE), ...value, ...lv(result.offset));
        } else {
          const value =
            result.type.kind === "integer"
              ? this.integerParameter(terminator.value)
              : result.type.kind === "boolean"
                ? this.parameter(terminator.value)
                : this.floatParameter(terminator.value);
          if (!value) {
            this.diagnostics.push(
              diagnostic("EV32004", "Unable to encode the function return value.", terminator.span),
            );
            return;
          }
          const opcode =
            result.type.kind === "integer"
              ? OP.MOVE_32_32
              : result.type.kind === "boolean"
                ? OP.MOVE_8_8
                : OP.MOVE_F_F;
          this.bytes.push(opcode, ...value, ...lv(result.offset));
        }
      }
      this.jump(OBJECT_EPILOGUE, next);
      return;
    }
    if (terminator.op === "jump") {
      // Clev3r permits a Thread.Run Sub to contain a tight loop.  On EV3 this
      // needs an explicit scheduler break; otherwise the worker can consume
      // every VM time slice before the main object, UI, or USB service runs.
      // A known target is a backwards edge because blocks are emitted in
      // source order, so yielding here preserves normal straight-line calls.
      if (this.isBackgroundThread && this.labels.has(terminator.target)) this.bytes.push(OP.SLEEP);
      this.jump(terminator.target, next);
      return;
    }
    if (this.optimize) {
      if (terminator.condition.kind === "boolean") {
        this.jump(terminator.condition.value ? terminator.whenTrue : terminator.whenFalse, next);
        return;
      }
      if (terminator.whenTrue === terminator.whenFalse) {
        this.jump(terminator.whenTrue, next);
        return;
      }
    }
    const condition = this.parameter(terminator.condition);
    if (!condition) return;
    if (this.optimize && terminator.whenFalse === next) {
      this.bytes.push(OP.JR_TRUE, ...condition);
      this.addPatch(terminator.whenTrue);
      return;
    }
    this.bytes.push(OP.JR_FALSE, ...condition);
    this.addPatch(terminator.whenFalse);
    this.jump(terminator.whenTrue, next);
  }

  private addPatch(target: Label): void {
    const at = this.bytes.length;
    this.bytes.push(...relativeOffset(0));
    this.patches.push({ at, after: this.bytes.length, target });
  }
}

export interface EV3BackendOptions {
  /** Disable all optimizations for output comparisons. */
  optimize?: boolean;
  /** Additional call-graph roots for tooling that invokes subcalls directly. */
  retainFunctions?: readonly string[];
}

export class EV3Backend implements CompilerBackend {
  readonly id = "ev3-native" as const;

  constructor(readonly options: EV3BackendOptions = {}) {}

  async compile(ir: KobrixaIR, signal: AbortSignal): Promise<BackendResult> {
    signal.throwIfAborted();
    const functions = new Map(ir.functions.map((fn) => [fn.name.toLocaleLowerCase("en-US"), fn]));
    const retained = this.options.retainFunctions ?? [];
    const diagnostics = retained
      .filter((name) => !functions.has(name.toLocaleLowerCase("en-US")))
      .map((name) => diagnostic("EV32003", `Unknown retained function '${name}'.`));
    if (diagnostics.length) return { diagnostics };
    if (this.options.optimize === false) return this.emit(expandRecursiveCalls(ir), signal, false);

    // Check every source function before pruning or rewriting it. Reuse the
    // actual lowerer, but discard code and avoid expanding unreachable recursion.
    const checked = this.emit(ir, signal, false, true);
    if (checked.diagnostics.length) return checked;
    if (!functions.has(ir.program.entryFunction.toLocaleLowerCase("en-US")))
      return {
        diagnostics: [
          diagnostic("EV32003", `Unknown entry function '${ir.program.entryFunction}'.`),
        ],
      };
    const optimized = {
      ...ir,
      functions: reachableFunctions(ir, retained, signal).map((fn) =>
        eliminateCopies(fn, functions, signal),
      ),
    };
    return this.emit(expandRecursiveCalls(optimized), signal, true, false, ir);
  }

  private emit(
    ir: KobrixaIR,
    signal: AbortSignal,
    optimize: boolean,
    diagnosticsOnly = false,
    storageIR = ir,
  ): BackendResult {
    const diagnostics: Diagnostic[] = [];
    const objects: RbfObject[] = [];
    const listing: string[] = [];
    const callables = new Map<string, CallableFunction>(
      ir.functions.map((fn, index) => [
        fn.name.toLocaleLowerCase("en-US"),
        { fn, objectId: index + 1 },
      ]),
    );
    // Runtime support storage is based on the full input, keeping global
    // offsets and initialization stable when unused functions are removed.
    const hasMutexes = storageIR.functions.some((fn) =>
      fn.blocks.some((block) =>
        block.instructions.some(
          (instruction) =>
            instruction.op === "ev3-call" &&
            ["Thread.CreateMutex", "Thread.Lock", "Thread.Unlock"].includes(instruction.operation),
        ),
      ),
    );
    const hasLcdUpdateControl = storageIR.functions.some((fn) =>
      fn.blocks.some((block) =>
        block.instructions.some(
          (instruction) =>
            instruction.op === "ev3-call" && instruction.operation === "LCD.StopUpdate",
        ),
      ),
    );
    let globalBytes = hasMutexes || hasLcdUpdateControl ? 8 : 0;
    const globalAllocations = new Map<string, Allocation>();
    for (const variable of ir.globals) {
      const alignment = sizeOf(variable.type) >= 4 ? 4 : 1;
      globalBytes = Math.ceil(globalBytes / alignment) * alignment;
      globalAllocations.set(variable.name.toLocaleLowerCase("en-US"), {
        offset: globalBytes,
        type: variable.type,
        scope: "global",
      });
      globalBytes += sizeOf(variable.type);
    }
    const mailboxAllocator = { next: 0 };
    const hasTimers = storageIR.functions.some((fn) =>
      fn.blocks.some((block) =>
        block.instructions.some(
          (instruction) =>
            instruction.op === "ev3-call" && /^Time\.(Get|Reset)[1-9]$/.test(instruction.operation),
        ),
      ),
    );
    // All functions and threads observe the same nine program timers.
    const timerBaselines = hasTimers ? Math.ceil(globalBytes / 4) * 4 : undefined;
    if (timerBaselines !== undefined) globalBytes = timerBaselines + 9 * 4;
    const threadTargets = new Set(
      ir.functions.flatMap((fn) =>
        fn.blocks.flatMap((block) =>
          block.instructions
            .filter((instruction) => instruction.op === "thread-start")
            .map((instruction) => instruction.functionName.toLocaleLowerCase("en-US")),
        ),
      ),
    );
    const threadObjects = new Map(
      [...threadTargets].map((name, index) => [name, ir.functions.length + index + 1]),
    );
    const mutexObjectId = ir.functions.length + threadObjects.size + 1;
    for (const [index, fn] of ir.functions.entries()) {
      const assembler = new ObjectAssembler(
        fn,
        index + 1,
        callables,
        hasMutexes,
        hasLcdUpdateControl,
        mailboxAllocator,
        globalAllocations,
        threadObjects,
        mutexObjectId,
        timerBaselines,
        optimize,
        signal,
        ir.program.runtimeDirectory,
      );
      const code = assembler.assemble(signal);
      diagnostics.push(...assembler.diagnostics);
      if (diagnosticsOnly) continue;
      objects.push({
        // The main program is a VM thread. Every generated function is an
        // EV3 SUBCALL object and therefore needs its parameter descriptor
        // (owner 0, trigger count 1), not a block-object header.
        ownerObjectId: 0,
        triggerCount: index === 0 ? 0 : 1,
        localBytes: assembler.localBytes,
        code,
      });
      listing.push(
        `${index + 1}\t${fn.name}\tlocals=${assembler.localBytes}\t${[...code].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`,
      );
    }
    for (const [functionName, objectId] of threadObjects) {
      const callable = callables.get(functionName);
      if (!callable) {
        diagnostics.push(diagnostic("EV32030", `No thread Sub '${functionName}' was emitted.`));
        continue;
      }
      if (diagnosticsOnly) continue;
      const code = Uint8Array.from([OP.CALL, ...lc(callable.objectId), ...lc(0), OP.OBJECT_END]);
      objects.push({ ownerObjectId: 0, triggerCount: 0, localBytes: 0, code });
      listing.push(
        `${objectId}\tthread:${functionName}\tlocals=0\t${[...code].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`,
      );
    }
    if (diagnosticsOnly) return { diagnostics };
    if (hasMutexes) {
      const write = [OP.ARRAY_WRITE, ...gv(0), ...lv(0), ...lc(1)];
      const code = Uint8Array.from([
        2,
        0x82,
        0x40, // DATA32 index input, DATA8 acquired output
        OP.ARRAY_READ,
        ...gv(0),
        ...lv(0),
        ...lv(5),
        OP.CP_EQ_8,
        ...lv(5),
        ...lc(0),
        ...lv(4),
        OP.JR_FALSE,
        ...lv(4),
        ...relativeOffset(write.length),
        ...write,
        OP.RETURN,
        OP.OBJECT_END,
      ]);
      objects.push({ ownerObjectId: 0, triggerCount: 1, localBytes: 6, code });
      listing.push(
        `${mutexObjectId}\tmutex:try-acquire\tlocals=6\t${[...code].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`,
      );
    }
    if (diagnostics.some((item) => item.severity === "error")) return { diagnostics };
    const rbf = createRbf(objects, globalBytes);
    try {
      inspectRbf(rbf);
      return { rbf, listing: `${listing.join("\n")}\n`, diagnostics };
    } catch (error) {
      return {
        diagnostics: [
          diagnostic(
            "EV39000",
            error instanceof Error ? error.message : "Invalid generated EV3 image.",
          ),
        ],
      };
    }
  }
}
