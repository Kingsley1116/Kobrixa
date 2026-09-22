import type { Diagnostic } from "@kobrixa/compiler";
import {
  getEV3Operation,
  type EV3ParameterType,
  type IRBasicBlock,
  type IRFunction,
  type IRInstruction,
  type IRPrimitiveType,
  type IRTerminator,
  type IRType,
  type IRValue,
  type IRVariable,
  type KobrixaIR,
  type SourceSpan,
} from "@kobrixa/ir";
import path from "node:path";
import type { Expression, FunctionDeclaration, Statement } from "./ast.js";

interface LoweredValue {
  value: IRValue;
  type: IRType;
}

function inferredExpressionType(expression: Expression): IRType {
  if (expression.kind === "literal") {
    if (typeof expression.value === "string") return { kind: "string" };
    if (typeof expression.value === "boolean") return { kind: "boolean" };
    return { kind: Number.isInteger(expression.value) ? "integer" : "number" };
  }
  if (expression.kind === "binary" && expression.operator === "+") {
    const left = inferredExpressionType(expression.left);
    const right = inferredExpressionType(expression.right);
    if (left.kind === "string" || right.kind === "string") return { kind: "string" };
  }
  if (expression.kind === "call") {
    const operation = getEV3Operation(expression.name);
    if (operation)
      return typeof operation.returns === "string"
        ? { kind: operation.returns }
        : operation.returns;
  }
  return { kind: "number" };
}

function inferredFunctionReturnType(declaration: FunctionDeclaration): IRType {
  const types: IRType[] = [];
  const visit = (statements: Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "return" && statement.value)
        types.push(inferredExpressionType(statement.value));
      if (statement.kind === "if") {
        for (const branch of statement.branches) visit(branch.body);
        visit(statement.otherwise);
      }
      if (statement.kind === "while" || statement.kind === "for") visit(statement.body);
    }
  };
  visit(declaration.body);
  // Every return uses one shared call ABI, including early-return branches.
  if (types.every((type) => type.kind === "integer" || type.kind === "number"))
    return {
      kind:
        types.length > 0 && types.every((type) => type.kind === "integer") ? "integer" : "number",
    };
  return types[0] ?? { kind: "number" };
}

function canonical(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

function textualBoolean(value: string): boolean | undefined {
  const normalized = value.toLocaleLowerCase("en-US");
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function isNegativeConstant(expression: Expression): boolean {
  return (
    (expression.kind === "literal" &&
      typeof expression.value === "number" &&
      expression.value < 0) ||
    (expression.kind === "unary" &&
      expression.operator === "-" &&
      expression.value.kind === "literal" &&
      typeof expression.value.value === "number" &&
      expression.value.value > 0)
  );
}

function toDiagnostic(code: string, message: string, span: SourceSpan): Diagnostic {
  return {
    code,
    severity: "error",
    file: span.file,
    range: {
      startLine: span.start.line,
      startColumn: span.start.column,
      endLine: span.end.line,
      endColumn: span.end.column,
    },
    message,
  };
}

class FunctionBuilder {
  readonly blocks: IRBasicBlock[] = [];
  readonly variables = new Map<string, IRVariable>();
  readonly diagnostics: Diagnostic[] = [];
  #current: IRBasicBlock;
  #blockCounter = 0;
  #temporaryCounter = 0;
  #terminated = false;
  readonly #loopTargets: Array<{ breakTarget: string; continueTarget: string }> = [];
  readonly #knownFunctions: ReadonlyMap<string, FunctionDeclaration>;
  readonly #globalLabels: ReadonlySet<string>;
  #localLabels = new Set<string>();

  constructor(
    readonly name: string,
    parameters: FunctionDeclaration["parameters"],
    readonly returnType: IRType,
    knownFunctions: ReadonlyMap<string, FunctionDeclaration>,
    readonly globals: Map<string, IRVariable>,
    readonly globalScope: boolean,
    globalLabels: ReadonlySet<string>,
  ) {
    this.#knownFunctions = knownFunctions;
    this.#globalLabels = globalLabels;
    for (const parameter of parameters)
      this.addVariable(parameter.name, parameter.type, "parameter", undefined, parameter.direction);
    this.#current = this.createBlock("entry");
  }

  compile(statements: Statement[]): IRFunction {
    this.#localLabels = new Set(
      statements
        .filter((statement) => statement.kind === "label")
        .map((statement) => canonical(statement.label)),
    );
    this.compileStatements(statements);
    if (!this.#terminated)
      this.terminate(
        this.returnType.kind === "void"
          ? { op: "return" }
          : { op: "return", value: { kind: "number", value: 0 } },
      );
    const parameters = [...this.variables.values()].filter(
      (variable) => variable.scope === "parameter",
    );
    const locals = [...this.variables.values()].filter(
      (variable) => variable.scope === "local" || variable.scope === "temporary",
    );
    return {
      name: this.name,
      parameters,
      returnType: this.returnType,
      locals,
      entryBlock: "entry",
      blocks: this.blocks,
    };
  }

  private compileStatements(statements: Statement[]): void {
    for (const statement of statements) {
      if (this.#terminated && statement.kind !== "label")
        this.switchTo(this.createBlock("unreachable"));
      switch (statement.kind) {
        case "assign": {
          const value = this.lowerExpression(statement.value);
          const variable = this.ensureVariable(
            statement.name,
            value.type,
            statement.span,
            statement.global,
          );
          if (!this.assignable(variable.type, value.type)) {
            this.diagnostics.push(
              toDiagnostic(
                "BP2002",
                `Cannot assign ${value.type.kind} to ${variable.type.kind}.`,
                statement.span,
              ),
            );
          }
          this.emit({
            op: "assign",
            target: variable.name,
            value: value.value,
            span: statement.span,
          });
          break;
        }
        case "declaration":
          this.ensureVariable(statement.name, statement.type, statement.span, this.globalScope);
          break;
        case "array-assign": {
          const value = this.lowerExpression(statement.value);
          const array = this.lowerExpression(statement.array, {
            kind: "array",
            element: value.type.kind === "string" ? "string" : "number",
          });
          const index = this.lowerExpression(statement.index, { kind: "integer" });
          if (array.type.kind !== "array") {
            this.diagnostics.push(
              toDiagnostic(
                "BP2008",
                "Array assignment requires an array variable.",
                statement.span,
              ),
            );
            break;
          }
          const element: IRType = { kind: array.type.element };
          if (!this.assignable(element, value.type)) {
            this.diagnostics.push(
              toDiagnostic(
                "BP2002",
                `Cannot assign ${value.type.kind} to ${array.type.element} array element.`,
                statement.span,
              ),
            );
            break;
          }
          this.emit({
            op: "ev3-call",
            operation: "Row.Write",
            args: [array.value, index.value, value.value],
            span: statement.span,
          });
          break;
        }
        case "call":
          this.lowerCall(statement.call, false);
          break;
        case "thread-run": {
          const declaration = this.#knownFunctions.get(canonical(statement.functionName));
          if (!declaration) {
            this.diagnostics.push(
              toDiagnostic(
                "BP3001",
                `Unsupported or unresolved thread Sub '${statement.functionName}'.`,
                statement.span,
              ),
            );
          } else if (declaration.kind !== "sub" || declaration.parameters.length !== 0) {
            this.diagnostics.push(
              toDiagnostic(
                "BP2009",
                "Thread.Run requires a Sub with no parameters.",
                statement.span,
              ),
            );
          } else {
            this.emit({
              op: "thread-start",
              functionName: canonical(declaration.name),
              span: statement.span,
            });
          }
          break;
        }
        case "property":
          this.ensureVariable(statement.name, { kind: "number" }, statement.span);
          break;
        case "return": {
          const lowered = statement.value ? this.lowerExpression(statement.value) : undefined;
          if (
            lowered &&
            lowered.type.kind !== this.returnType.kind &&
            !(this.returnType.kind === "number" && lowered.type.kind === "integer")
          ) {
            this.diagnostics.push(
              toDiagnostic(
                "BP2010",
                `Return value has type ${lowered.type.kind}, expected ${this.returnType.kind}.`,
                statement.span,
              ),
            );
          }
          const value = lowered?.value;
          this.terminate(
            value
              ? { op: "return", value, span: statement.span }
              : { op: "return", span: statement.span },
          );
          break;
        }
        case "break": {
          const loop = this.#loopTargets.at(-1);
          if (!loop) {
            this.diagnostics.push(
              toDiagnostic("BP2006", "Break can only be used inside For or While.", statement.span),
            );
            break;
          }
          this.terminate({ op: "jump", target: loop.breakTarget, span: statement.span });
          break;
        }
        case "continue": {
          const loop = this.#loopTargets.at(-1);
          if (!loop) {
            this.diagnostics.push(
              toDiagnostic(
                "BP2007",
                "Continue can only be used inside For or While.",
                statement.span,
              ),
            );
            break;
          }
          this.terminate({ op: "jump", target: loop.continueTarget, span: statement.span });
          break;
        }
        case "goto":
          // Clev3r labels are program-wide. A subroutine may jump to a
          // top-level ending label; ending this EV3 object preserves that
          // behavior without creating an invalid cross-object branch.
          if (
            !this.globalScope &&
            !this.#localLabels.has(canonical(statement.label)) &&
            this.#globalLabels.has(canonical(statement.label))
          ) {
            this.terminate({ op: "stop", span: statement.span });
            break;
          }
          this.terminate({
            op: "jump",
            target: this.labelId(statement.label),
            span: statement.span,
          });
          break;
        case "label": {
          const block = this.getOrCreateLabel(statement.label);
          if (!this.#terminated && this.#current !== block)
            this.terminate({ op: "jump", target: block.id, span: statement.span });
          this.switchTo(block);
          break;
        }
        case "if":
          this.compileIf(statement);
          break;
        case "while":
          this.compileWhile(statement);
          break;
        case "for":
          this.compileFor(statement);
          break;
      }
    }
  }

  private compileIf(statement: Extract<Statement, { kind: "if" }>): void {
    const merge = this.createBlock("if_end");
    for (const branch of statement.branches) {
      const body = this.createBlock("if_body");
      const next = this.createBlock("if_next");
      const condition = this.lowerExpression(branch.condition, { kind: "boolean" });
      this.terminate({
        op: "branch",
        condition: condition.value,
        whenTrue: body.id,
        whenFalse: next.id,
        span: branch.condition.span,
      });
      this.switchTo(body);
      this.compileStatements(branch.body);
      if (!this.#terminated) this.terminate({ op: "jump", target: merge.id, span: statement.span });
      this.switchTo(next);
    }
    this.compileStatements(statement.otherwise);
    if (!this.#terminated) this.terminate({ op: "jump", target: merge.id, span: statement.span });
    this.switchTo(merge);
  }

  private compileWhile(statement: Extract<Statement, { kind: "while" }>): void {
    const conditionBlock = this.createBlock("while_condition");
    const body = this.createBlock("while_body");
    const end = this.createBlock("while_end");
    this.terminate({ op: "jump", target: conditionBlock.id, span: statement.span });
    this.switchTo(conditionBlock);
    const condition = this.lowerExpression(statement.condition, { kind: "boolean" });
    this.terminate({
      op: "branch",
      condition: condition.value,
      whenTrue: body.id,
      whenFalse: end.id,
      span: statement.condition.span,
    });
    this.switchTo(body);
    this.#loopTargets.push({ breakTarget: end.id, continueTarget: conditionBlock.id });
    this.compileStatements(statement.body);
    this.#loopTargets.pop();
    if (!this.#terminated)
      this.terminate({ op: "jump", target: conditionBlock.id, span: statement.span });
    this.switchTo(end);
  }

  private compileFor(statement: Extract<Statement, { kind: "for" }>): void {
    const initial = this.lowerExpression(statement.start);
    const variable = this.ensureVariable(statement.variable, initial.type, statement.span);
    this.emit({ op: "assign", target: variable.name, value: initial.value, span: statement.span });
    const conditionBlock = this.createBlock("for_condition");
    const body = this.createBlock("for_body");
    const update = this.createBlock("for_update");
    const end = this.createBlock("for_end");
    this.terminate({ op: "jump", target: conditionBlock.id, span: statement.span });
    this.switchTo(conditionBlock);
    const limit = this.lowerExpression(statement.end);
    const comparison = this.newTemporary({ kind: "boolean" }, statement.span);
    this.emit({
      op: "binary",
      target: comparison.name,
      operator: isNegativeConstant(statement.step) ? ">=" : "<=",
      left: { kind: "variable", name: variable.name },
      right: limit.value,
      span: statement.span,
    });
    this.terminate({
      op: "branch",
      condition: { kind: "variable", name: comparison.name },
      whenTrue: body.id,
      whenFalse: end.id,
      span: statement.span,
    });
    this.switchTo(body);
    this.#loopTargets.push({ breakTarget: end.id, continueTarget: update.id });
    this.compileStatements(statement.body);
    this.#loopTargets.pop();
    if (!this.#terminated) this.terminate({ op: "jump", target: update.id, span: statement.span });
    this.switchTo(update);
    const step = this.lowerExpression(statement.step);
    const updatedType: IRType =
      variable.type.kind === "integer" && step.type.kind === "integer"
        ? { kind: "integer" }
        : { kind: "number" };
    const updated = this.newTemporary(updatedType, statement.span);
    this.emit({
      op: "binary",
      target: updated.name,
      operator: "+",
      left: { kind: "variable", name: variable.name },
      right: step.value,
      span: statement.span,
    });
    this.emit({
      op: "assign",
      target: variable.name,
      value: { kind: "variable", name: updated.name },
      span: statement.span,
    });
    this.terminate({ op: "jump", target: conditionBlock.id, span: statement.span });
    this.switchTo(end);
  }

  private lowerExpression(expression: Expression, expected?: IRType): LoweredValue {
    switch (expression.kind) {
      case "literal": {
        if (typeof expression.value === "boolean")
          return { value: { kind: "boolean", value: expression.value }, type: { kind: "boolean" } };
        if (typeof expression.value === "string") {
          const booleanValue =
            expected?.kind === "boolean" ? textualBoolean(expression.value) : undefined;
          return booleanValue === undefined
            ? { value: { kind: "string", value: expression.value }, type: { kind: "string" } }
            : { value: { kind: "boolean", value: booleanValue }, type: { kind: "boolean" } };
        }
        return Number.isInteger(expression.value)
          ? {
              value: { kind: "integer", value: expression.value },
              type: { kind: "integer" },
            }
          : { value: { kind: "number", value: expression.value }, type: { kind: "number" } };
      }
      case "name": {
        const operation = getEV3Operation(expression.name);
        if (operation?.parameters.length === 0)
          return this.lowerCall(
            { kind: "call", name: expression.name, args: [], span: expression.span },
            true,
          )!;
        // Reading a variable must not change its storage representation.
        const key = canonical(expression.name);
        const variable =
          this.variables.get(key) ??
          this.globals.get(key) ??
          this.ensureVariable(
            expression.name,
            expected ?? { kind: "number" },
            expression.span,
            expression.global,
          );
        return { value: { kind: "variable", name: variable.name }, type: variable.type };
      }
      case "index": {
        const array = this.lowerExpression(expression.array, {
          kind: "array",
          element: "number",
        });
        const index = this.lowerExpression(expression.index, { kind: "integer" });
        const element = array.type.kind === "array" ? array.type.element : "number";
        const target = this.newTemporary({ kind: element }, expression.span);
        this.emit({
          op: "ev3-call",
          target: target.name,
          operation: "Row.Read",
          args: [array.value, index.value],
          span: expression.span,
        });
        return { value: { kind: "variable", name: target.name }, type: target.type };
      }
      case "unary": {
        const value = this.lowerExpression(
          expression.value,
          expression.operator === "not" ? { kind: "boolean" } : undefined,
        );
        const type: IRType =
          expression.operator === "not"
            ? { kind: "boolean" }
            : value.type.kind === "integer"
              ? { kind: "integer" }
              : { kind: "number" };
        const target = this.newTemporary(type, expression.span);
        this.emit({
          op: "unary",
          target: target.name,
          operator: expression.operator,
          value: value.value,
          span: expression.span,
        });
        return { value: { kind: "variable", name: target.name }, type };
      }
      case "binary": {
        const expectedOperand = ["and", "or"].includes(expression.operator)
          ? ({ kind: "boolean" } as const)
          : undefined;
        const left = this.lowerExpression(expression.left, expectedOperand);
        const right = this.lowerExpression(expression.right, expectedOperand);
        const booleanResult = ["=", "<>", "<", "<=", ">", ">=", "and", "or"].includes(
          expression.operator,
        );
        const type: IRType = booleanResult
          ? { kind: "boolean" }
          : expression.operator === "+" &&
              (left.type.kind === "string" || right.type.kind === "string")
            ? { kind: "string" }
            : left.type.kind === "integer" &&
                right.type.kind === "integer" &&
                expression.operator !== "/"
              ? { kind: "integer" }
              : { kind: "number" };
        const target = this.newTemporary(type, expression.span);
        this.emit({
          op: "binary",
          target: target.name,
          operator: expression.operator,
          left: left.value,
          right: right.value,
          span: expression.span,
        });
        return { value: { kind: "variable", name: target.name }, type };
      }
      case "call":
        return (
          this.lowerCall(expression, true) ?? {
            value: { kind: "number", value: 0 },
            type: { kind: "number" },
          }
        );
    }
  }

  private lowerCall(
    expression: Extract<Expression, { kind: "call" }>,
    needsValue: boolean,
  ): LoweredValue | undefined {
    const operation = getEV3Operation(expression.name);
    const declaration = this.#knownFunctions.get(canonical(expression.name));
    const args = expression.args.map((argument, index) => {
      const operationType = operation?.parameters[index];
      const expected: IRType | undefined = operationType
        ? this.preferredOperationType(operationType)
        : declaration?.parameters[index]?.type;
      // An output writes the caller's storage. A numeric literal used to
      // initialize that storage must not prevent a later floating-point output.
      if (
        declaration?.parameters[index]?.direction === "out" &&
        argument.kind === "name" &&
        expected?.kind === "number"
      )
        this.ensureVariable(argument.name, expected, argument.span, argument.global);
      return this.lowerExpression(argument, expected);
    });
    if (operation) {
      if (operation.parameters.length !== args.length) {
        this.diagnostics.push(
          toDiagnostic(
            "BP3002",
            `'${operation.name}' expects ${operation.parameters.length} arguments.`,
            expression.span,
          ),
        );
      }
      operation.parameters.forEach((expected, index) => {
        const actual = args[index]?.type.kind;
        const accepted = Array.isArray(expected) ? expected : [expected];
        if (
          actual &&
          !accepted.includes(actual) &&
          !(accepted.includes("number") && actual === "integer") &&
          !(accepted.includes("integer") && actual === "number")
        ) {
          this.diagnostics.push(
            toDiagnostic(
              "BP3004",
              `Argument ${index + 1} of '${operation.name}' expects ${expected}, got ${actual}.`,
              expression.args[index]?.span ?? expression.span,
            ),
          );
        }
      });
      const type: IRType =
        typeof operation.returns === "string" ? { kind: operation.returns } : operation.returns;
      const target = type.kind !== "void" ? this.newTemporary(type, expression.span) : undefined;
      const instruction: IRInstruction = target
        ? {
            op: "ev3-call",
            target: target.name,
            operation: operation.name,
            args: args.map((item) => item.value),
            span: expression.span,
          }
        : {
            op: "ev3-call",
            operation: operation.name,
            args: args.map((item) => item.value),
            span: expression.span,
          };
      this.emit(instruction);
      if (target) return { value: { kind: "variable", name: target.name }, type };
      if (needsValue)
        this.diagnostics.push(
          toDiagnostic("BP3003", `'${operation.name}' does not return a value.`, expression.span),
        );
      return undefined;
    }
    if (!declaration) {
      this.diagnostics.push(
        toDiagnostic(
          "BP3001",
          `Unsupported or unresolved call '${expression.name}'.`,
          expression.span,
        ),
      );
      return undefined;
    }
    if (declaration.parameters.length !== args.length) {
      this.diagnostics.push(
        toDiagnostic(
          "BP2004",
          `'${declaration.name}' expects ${declaration.parameters.length} arguments.`,
          expression.span,
        ),
      );
    }
    declaration.parameters.forEach((parameter, index) => {
      const actual = args[index]?.type;
      if (
        parameter.direction === "out" &&
        actual &&
        (actual.kind !== parameter.type.kind ||
          (actual.kind === "array" &&
            parameter.type.kind === "array" &&
            actual.element !== parameter.type.element))
      ) {
        this.diagnostics.push(
          toDiagnostic(
            "BP2006",
            `Output argument ${index + 1} of '${declaration.name}' must have type ${parameter.type.kind}.`,
            expression.args[index]?.span ?? expression.span,
          ),
        );
      }
    });
    const returnsValue = declaration.kind === "function";
    const target = returnsValue
      ? this.newTemporary(declaration.returnType ?? { kind: "number" }, expression.span)
      : undefined;
    this.emit(
      target
        ? {
            op: "call",
            target: target.name,
            functionName: canonical(declaration.name),
            args: args.map((item) => item.value),
            span: expression.span,
          }
        : {
            op: "call",
            functionName: canonical(declaration.name),
            args: args.map((item) => item.value),
            span: expression.span,
          },
    );
    if (target) return { value: { kind: "variable", name: target.name }, type: target.type };
    if (needsValue)
      this.diagnostics.push(
        toDiagnostic("BP2005", `'${declaration.name}' does not return a value.`, expression.span),
      );
    return undefined;
  }

  private preferredOperationType(expected: EV3ParameterType): IRType {
    const choices = typeof expected === "string" ? [expected] : expected;
    if (choices.includes("number")) return { kind: "number" };
    if (choices.includes("array")) return { kind: "array", element: "number" };
    return { kind: choices[0]! as IRPrimitiveType };
  }

  private ensureVariable(
    name: string,
    type: IRType,
    span: SourceSpan,
    forceGlobal = false,
  ): IRVariable {
    const key = canonical(name);
    const existing = this.variables.get(key);
    if (existing) {
      if (type.kind === "number" && existing.type.kind === "integer")
        existing.type = { kind: "number" };
      return existing;
    }
    const global = this.globals.get(key);
    if (global) {
      if (type.kind === "number" && global.type.kind === "integer")
        global.type = { kind: "number" };
      return global;
    }
    if (forceGlobal || this.globalScope) {
      const variable = this.addVariable(key, type, "global", span);
      this.globals.set(key, variable);
      return variable;
    }
    return this.addVariable(key, type, "local", span);
  }

  private addVariable(
    name: string,
    type: IRType,
    scope: IRVariable["scope"],
    span?: SourceSpan,
    direction?: "in" | "out",
  ): IRVariable {
    const directionField = direction === undefined ? {} : { direction };
    const variable: IRVariable = span
      ? { name: canonical(name), type, scope, ...directionField, span }
      : { name: canonical(name), type, scope, ...directionField };
    this.variables.set(canonical(name), variable);
    return variable;
  }

  private newTemporary(type: IRType, span: SourceSpan): IRVariable {
    this.#temporaryCounter += 1;
    return this.addVariable(`$t${this.#temporaryCounter}`, type, "temporary", span);
  }

  private emit(instruction: IRInstruction): void {
    this.#current.instructions.push(instruction);
  }

  private terminate(terminator: IRTerminator): void {
    this.#current.terminator = terminator;
    this.#terminated = true;
  }

  private createBlock(prefix: string): IRBasicBlock {
    const id = prefix === "entry" ? "entry" : `${prefix}_${++this.#blockCounter}`;
    const block: IRBasicBlock = { id, instructions: [], terminator: { op: "stop" } };
    this.blocks.push(block);
    return block;
  }

  private switchTo(block: IRBasicBlock): void {
    this.#current = block;
    this.#terminated = block.terminator.op !== "stop" || block.instructions.length > 0;
  }

  private labelId(label: string): string {
    return `label_${canonical(label).replace(/[^a-z0-9_]/g, "_")}`;
  }

  private getOrCreateLabel(label: string): IRBasicBlock {
    const id = this.labelId(label);
    return (
      this.blocks.find((block) => block.id === id) ??
      (() => {
        const block: IRBasicBlock = { id, instructions: [], terminator: { op: "stop" } };
        this.blocks.push(block);
        return block;
      })()
    );
  }

  private assignable(target: IRType, source: IRType): boolean {
    return (
      target.kind === source.kind ||
      (target.kind === "number" && ["integer", "boolean"].includes(source.kind)) ||
      (target.kind === "integer" && source.kind === "boolean")
    );
  }
}

export function lowerProgram(
  name: string,
  body: Statement[],
  declarations: FunctionDeclaration[],
  sourceFiles: string[],
): { ir: KobrixaIR; diagnostics: Diagnostic[] } {
  const known = new Map<string, FunctionDeclaration>();
  const diagnostics: Diagnostic[] = [];
  for (const declaration of declarations) {
    if (declaration.kind === "function")
      declaration.returnType = inferredFunctionReturnType(declaration);
    const key = canonical(declaration.name);
    if (known.has(key))
      diagnostics.push(
        toDiagnostic("BP2001", `Duplicate function '${declaration.name}'.`, declaration.span),
      );
    known.set(key, declaration);
    const moduleName = path.posix.basename(
      declaration.span.file,
      path.posix.extname(declaration.span.file),
    );
    const qualified = canonical(`${moduleName}.${declaration.name}`);
    if (!known.has(qualified)) known.set(qualified, declaration);
  }
  const functions: IRFunction[] = [];
  const globals = new Map<string, IRVariable>();
  const globalLabels = new Set(
    body
      .filter((statement) => statement.kind === "label")
      .map((statement) => canonical(statement.label)),
  );
  const main = new FunctionBuilder(
    "main",
    [],
    { kind: "void" },
    known,
    globals,
    true,
    globalLabels,
  );
  functions.push(main.compile(body));
  diagnostics.push(...main.diagnostics);
  for (const declaration of declarations) {
    const builder = new FunctionBuilder(
      canonical(declaration.name),
      declaration.parameters,
      declaration.kind === "function" ? declaration.returnType! : { kind: "void" },
      known,
      globals,
      false,
      globalLabels,
    );
    functions.push(builder.compile(declaration.body));
    diagnostics.push(...builder.diagnostics);
  }
  // A later function can widen shared numeric storage (including out arguments).
  // Propagate that representation to arithmetic and copies already lowered in
  // main or earlier functions, until the dependent values have stable types.
  let widened: boolean;
  do {
    widened = false;
    for (const fn of functions) {
      const variables = new Map([
        ...globals,
        ...[...fn.parameters, ...fn.locals].map((variable) => [variable.name, variable] as const),
      ]);
      const isNumber = (value: IRValue): boolean =>
        value.kind === "number" ||
        (value.kind === "variable" && variables.get(value.name)?.type.kind === "number");
      for (const block of fn.blocks) {
        for (const instruction of block.instructions) {
          if (!("target" in instruction) || !instruction.target) continue;
          const target = variables.get(instruction.target);
          if (target?.type.kind !== "integer") continue;
          const needsNumber =
            (instruction.op === "assign" && isNumber(instruction.value)) ||
            (instruction.op === "unary" &&
              instruction.operator === "-" &&
              isNumber(instruction.value)) ||
            (instruction.op === "binary" &&
              ["+", "-", "*", "/", "%"].includes(instruction.operator) &&
              (isNumber(instruction.left) || isNumber(instruction.right)));
          if (needsNumber) {
            target.type = { kind: "number" };
            widened = true;
          }
        }
      }
    }
  } while (widened);
  return {
    ir: {
      version: 1,
      program: { name, entryFunction: "main" },
      globals: [...globals.values()],
      functions,
      resources: [],
      sourceFiles: [...sourceFiles].sort(),
    },
    diagnostics,
  };
}
