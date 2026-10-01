import type { IRType, SourceSpan } from "@kobrixa/ir";

export type Expression =
  | { kind: "literal"; value: number | string | boolean; span: SourceSpan }
  | { kind: "name"; name: string; global?: boolean; span: SourceSpan }
  | { kind: "index"; array: Expression; index: Expression; span: SourceSpan }
  | { kind: "unary"; operator: "-" | "not"; value: Expression; span: SourceSpan }
  | {
      kind: "binary";
      operator: "+" | "-" | "*" | "/" | "%" | "=" | "<>" | "<" | "<=" | ">" | ">=" | "and" | "or";
      left: Expression;
      right: Expression;
      span: SourceSpan;
    }
  | { kind: "call"; name: string; args: Expression[]; nameSpan?: SourceSpan; span: SourceSpan };

export type Statement =
  | {
      kind: "assign";
      name: string;
      global?: boolean;
      value: Expression;
      nameSpan?: SourceSpan;
      span: SourceSpan;
    }
  | {
      kind: "array-assign";
      array: Expression;
      index: Expression;
      value: Expression;
      span: SourceSpan;
    }
  | { kind: "declaration"; name: string; type: IRType; nameSpan?: SourceSpan; span: SourceSpan }
  | { kind: "call"; call: Extract<Expression, { kind: "call" }>; span: SourceSpan }
  | {
      kind: "thread-run";
      functionName: string;
      nameSpan?: SourceSpan;
      operationSpan?: SourceSpan;
      span: SourceSpan;
    }
  | {
      kind: "if";
      branches: Array<{ condition: Expression; body: Statement[] }>;
      otherwise: Statement[];
      span: SourceSpan;
    }
  | { kind: "while"; condition: Expression; body: Statement[]; span: SourceSpan }
  | {
      kind: "for";
      variable: string;
      nameSpan?: SourceSpan;
      start: Expression;
      end: Expression;
      step: Expression;
      body: Statement[];
      span: SourceSpan;
    }
  | { kind: "return"; value?: Expression; span: SourceSpan }
  | { kind: "break"; span: SourceSpan }
  | { kind: "continue"; span: SourceSpan }
  | { kind: "goto"; label: string; nameSpan?: SourceSpan; span: SourceSpan }
  | { kind: "label"; label: string; nameSpan?: SourceSpan; span: SourceSpan }
  | { kind: "property"; name: string; nameSpan?: SourceSpan; span: SourceSpan };

export interface FunctionDeclaration {
  kind: "sub" | "function";
  name: string;
  nameSpan?: SourceSpan;
  parameters: Array<{
    name: string;
    nameSpan?: SourceSpan;
    direction: "in" | "out";
    type: IRType;
  }>;
  body: Statement[];
  span: SourceSpan;
  /** Inferred during lowering because Basic Plus declarations do not spell it out. */
  returnType?: IRType;
}

export interface ParsedFile {
  runtimeDirectory?: string;
  file: string;
  includes: Array<{ kind: "include" | "import"; path: string; span: SourceSpan }>;
  body: Statement[];
  functions: FunctionDeclaration[];
}
