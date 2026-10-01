import type { Diagnostic } from "@kobrixa/compiler";
import type { SourceSpan } from "@kobrixa/ir";
import type { Expression, FunctionDeclaration, ParsedFile, Statement } from "./ast.js";
import { lex, type Token } from "./lexer.js";

const binaryPrecedence = new Map<string, number>([
  ["or", 1],
  ["and", 2],
  ["=", 3],
  ["<>", 3],
  ["<", 3],
  ["<=", 3],
  [">", 3],
  [">=", 3],
  ["+", 4],
  ["-", 4],
  ["*", 5],
  ["/", 5],
  ["%", 5],
]);

function mergeSpan(start: SourceSpan, end: SourceSpan): SourceSpan {
  return { file: start.file, start: start.start, end: end.end };
}

export function parse(
  file: string,
  source: string,
): { parsed: ParsedFile; diagnostics: Diagnostic[] } {
  const result = lex(file, source);
  const parser = new Parser(result.tokens, result.diagnostics);
  return { parsed: parser.parseFile(file), diagnostics: result.diagnostics };
}

class Parser {
  #index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly diagnostics: Diagnostic[],
  ) {}

  parseFile(file: string): ParsedFile {
    const includes: ParsedFile["includes"] = [];
    const body: Statement[] = [];
    const functions: FunctionDeclaration[] = [];
    let runtimeDirectory: string | undefined;
    while (!this.is("eof")) {
      this.skipNewlines();
      if (this.is("eof")) break;
      if (this.keyword("include") || this.keyword("import")) {
        const start = this.take();
        const path = this.takeKind(
          "string",
          "BP1010",
          `${start.text} expects a quoted project-relative path.`,
        );
        if (path)
          includes.push({
            kind: start.text.toLowerCase() as "include" | "import",
            path: String(path.value),
            span: mergeSpan(start.span, path.span),
          });
        this.skipLine();
        continue;
      }
      if (this.keyword("folder")) {
        const start = this.take();
        const storage = this.takeKind("string", "BP1050", 'Folder expects "prjs" or "sd".');
        const directory = this.takeKind("string", "BP1050", "Folder expects a directory name.");
        const area = String(storage?.value).toLocaleLowerCase("en-US");
        const name = String(directory?.value ?? "");
        if (
          runtimeDirectory ||
          !["prjs", "sd"].includes(area) ||
          !name ||
          new TextEncoder().encode(name).length > 48 ||
          name === "." ||
          name === ".." ||
          name.includes("/") ||
          name.includes("\\") ||
          [...name].some((character) => character.charCodeAt(0) < 32)
        ) {
          this.error(
            "BP1051",
            "Use one Folder directive with storage prjs/sd and a single directory name of at most 48 UTF-8 bytes.",
            start.span,
          );
        } else
          runtimeDirectory = `/home/root/lms2012/prjs/${area === "sd" ? "SD_Card/" : ""}${name}`;
        this.skipLine();
        continue;
      }
      if (this.keyword("private")) {
        this.skipLine();
        continue;
      }
      if (this.keyword("sub") || this.keyword("function")) {
        const declaration = this.parseFunction();
        if (declaration) functions.push(declaration);
        continue;
      }
      if (
        this.keyword("module") ||
        this.keyword("endmodule") ||
        this.keyword("region") ||
        this.keyword("endregion")
      ) {
        this.skipLine();
        continue;
      }
      const statement = this.parseStatement([]);
      if (statement) body.push(statement);
      else this.skipLine();
    }
    return { file, includes, body, functions, ...(runtimeDirectory ? { runtimeDirectory } : {}) };
  }

  private parseFunction(): FunctionDeclaration | undefined {
    const start = this.take();
    const kind = start.text.toLowerCase() as "sub" | "function";
    const name = this.takeKind("identifier", "BP1011", `${kind} expects a name.`);
    if (!name) return undefined;
    const parameters: FunctionDeclaration["parameters"] = [];
    if (this.match("(")) {
      while (!this.isText(")") && !this.is("eof") && !this.is("newline")) {
        let direction: "in" | "out" = "in";
        if (this.keyword("in") || this.keyword("out"))
          direction = this.take().text.toLowerCase() as "in" | "out";
        let type: FunctionDeclaration["parameters"][number]["type"] = { kind: "number" };
        if (this.keyword("number") || this.keyword("string")) {
          const element = this.take().text.toLowerCase() as "number" | "string";
          type = { kind: element };
          if (this.match("[")) {
            this.expect("]", "BP1015", "Expected ']' in array parameter type.");
            type = { kind: "array", element };
          }
        }
        const parameter = this.takeKind("identifier", "BP1012", "Expected a parameter name.");
        if (parameter)
          parameters.push({ name: parameter.text, nameSpan: parameter.span, direction, type });
        if (!this.match(",")) break;
      }
      this.expect(")", "BP1013", "Expected ')' after parameters.");
    }
    this.skipLine();
    const endKeyword = kind === "sub" ? "endsub" : "endfunction";
    const body = this.parseBlock([endKeyword]);
    const end = this.current();
    if (!this.keyword(endKeyword)) this.error("BP1014", `Expected ${endKeyword}.`, end.span);
    else this.skipLine();
    return {
      kind,
      name: name.text,
      nameSpan: name.span,
      parameters,
      body,
      span: mergeSpan(start.span, end.span),
    };
  }

  private parseBlock(stops: string[]): Statement[] {
    const statements: Statement[] = [];
    while (!this.is("eof")) {
      this.skipNewlines();
      if (stops.some((stop) => this.keyword(stop))) break;
      const statement = this.parseStatement(stops);
      if (statement) statements.push(statement);
      else this.skipLine();
    }
    return statements;
  }

  private parseStatement(_stops: string[]): Statement | undefined {
    const start = this.current();
    if (this.keyword("if")) return this.parseIf();
    if (this.keyword("while")) return this.parseWhile();
    if (this.keyword("for")) return this.parseFor();
    if (this.keyword("return")) {
      this.take();
      const value = this.is("newline") || this.is("eof") ? undefined : this.parseExpression();
      const end = this.current();
      this.skipLine();
      return value
        ? { kind: "return", value, span: mergeSpan(start.span, value.span) }
        : { kind: "return", span: mergeSpan(start.span, end.span) };
    }
    if (this.keyword("break") || this.keyword("continue")) {
      const keyword = this.take();
      this.skipLine();
      return {
        kind: keyword.text.toLowerCase() as "break" | "continue",
        span: keyword.span,
      };
    }
    if (this.keyword("private")) {
      this.take();
      return undefined;
    }
    if (this.keyword("region") || this.keyword("endregion")) {
      this.skipLine();
      return undefined;
    }
    if (this.keyword("goto")) {
      this.take();
      const label = this.takeKind("identifier", "BP1020", "Goto expects a label.");
      this.skipLine();
      return label
        ? {
            kind: "goto",
            label: label.text,
            nameSpan: label.span,
            span: mergeSpan(start.span, label.span),
          }
        : undefined;
    }
    if (this.keyword("property")) {
      this.take();
      const name = this.takeKind("identifier", "BP1021", "Property expects a name.");
      this.skipLine();
      return name
        ? {
            kind: "property",
            name: name.text,
            nameSpan: name.span,
            span: mergeSpan(start.span, name.span),
          }
        : undefined;
    }
    if (this.keyword("number") || this.keyword("string")) {
      const typeToken = this.take();
      const element = typeToken.text.toLowerCase() as "number" | "string";
      const type = this.match("[")
        ? (this.expect("]", "BP1024", "Expected ']' in array declaration."),
          {
            kind: "array" as const,
            element,
          })
        : { kind: element };
      const name = this.takeKind("identifier", "BP1025", "Expected a variable name.");
      this.skipLine();
      return name
        ? {
            kind: "declaration",
            name: name.text,
            nameSpan: name.span,
            type,
            span: mergeSpan(start.span, name.span),
          }
        : undefined;
    }
    if (this.keyword("dim")) this.take();
    if (this.is("identifier") || this.isText("@")) {
      const global = this.match("@");
      const name = this.take();
      if (name.kind !== "identifier") {
        this.error("BP1026", "Expected a name after '@'.", name.span);
        return undefined;
      }
      if (this.match(":")) {
        this.skipLine();
        return {
          kind: "label",
          label: name.text,
          nameSpan: name.span,
          span: mergeSpan(start.span, name.span),
        };
      }
      if (name.text.toLowerCase() === "thread.run" && this.match("=")) {
        const functionName = this.takeKind(
          "identifier",
          "BP1029",
          "Thread.Run expects a Sub name.",
        );
        this.skipLine();
        return functionName
          ? {
              kind: "thread-run",
              functionName: functionName.text,
              nameSpan: functionName.span,
              operationSpan: name.span,
              span: mergeSpan(start.span, functionName.span),
            }
          : undefined;
      }
      if (name.text.toLowerCase() === "f.start" && this.match("=")) {
        this.takeKind("identifier", "BP1029", "F.Start expects a Sub name.");
        this.skipLine();
        return undefined;
      }
      if (this.match("=")) {
        const value = this.parseExpression();
        this.skipLine();
        return value
          ? {
              kind: "assign",
              name: name.text,
              nameSpan: name.span,
              ...(global ? { global: true } : {}),
              value,
              span: mergeSpan(start.span, value.span),
            }
          : undefined;
      }
      if (this.match("[")) {
        const index = this.parseExpression();
        this.expect("]", "BP1027", "Expected ']' after array index.");
        this.expect("=", "BP1028", "Expected '=' after array index.");
        const value = this.parseExpression();
        this.skipLine();
        const array: Expression = {
          kind: "name",
          name: name.text,
          ...(global ? { global: true } : {}),
          span: name.span,
        };
        return index && value
          ? {
              kind: "array-assign",
              array,
              index,
              value,
              span: mergeSpan(start.span, value.span),
            }
          : undefined;
      }
      const compound = ["+=", "-=", "*=", "/="].find((operator) => this.isText(operator));
      if (compound) {
        this.take();
        const right = this.parseExpression();
        this.skipLine();
        if (!right) return undefined;
        const left: Expression = {
          kind: "name",
          name: name.text,
          ...(global ? { global: true } : {}),
          span: name.span,
        };
        const value: Expression = {
          kind: "binary",
          operator: compound[0] as "+" | "-" | "*" | "/",
          left,
          right,
          span: mergeSpan(name.span, right.span),
        };
        return {
          kind: "assign",
          name: name.text,
          nameSpan: name.span,
          ...(global ? { global: true } : {}),
          value,
          span: mergeSpan(start.span, right.span),
        };
      }
      if (this.isText("++") || this.isText("--")) {
        const operator = this.take();
        this.skipLine();
        const value: Expression = {
          kind: "binary",
          operator: operator.text === "++" ? "+" : "-",
          left: {
            kind: "name",
            name: name.text,
            ...(global ? { global: true } : {}),
            span: name.span,
          },
          right: { kind: "literal", value: 1, span: operator.span },
          span: mergeSpan(name.span, operator.span),
        };
        return {
          kind: "assign",
          name: name.text,
          nameSpan: name.span,
          ...(global ? { global: true } : {}),
          value,
          span: value.span,
        };
      }
      if (this.isText("(")) {
        const call = this.finishCall(name);
        this.skipLine();
        return { kind: "call", call, span: call.span };
      }
      this.error("BP1022", `Expected assignment or call after '${name.text}'.`, name.span);
      return undefined;
    }
    this.error("BP1023", `Unexpected token '${start.text}'.`, start.span);
    return undefined;
  }

  private parseIf(): Statement {
    const start = this.take();
    const condition = this.parseExpression();
    if (this.keyword("then")) this.take();
    this.skipLine();
    const branches: Array<{ condition: Expression; body: Statement[] }> = [];
    branches.push({
      condition: condition ?? this.falseExpression(start.span),
      body: this.parseBlock(["elseif", "else", "endif"]),
    });
    while (this.keyword("elseif")) {
      this.take();
      const branchCondition = this.parseExpression() ?? this.falseExpression(this.current().span);
      if (this.keyword("then")) this.take();
      this.skipLine();
      branches.push({
        condition: branchCondition,
        body: this.parseBlock(["elseif", "else", "endif"]),
      });
    }
    let otherwise: Statement[] = [];
    if (this.keyword("else")) {
      this.skipLine();
      otherwise = this.parseBlock(["endif"]);
    }
    const end = this.current();
    if (!this.keyword("endif")) this.error("BP1030", "Expected EndIf.", end.span);
    else this.skipLine();
    return { kind: "if", branches, otherwise, span: mergeSpan(start.span, end.span) };
  }

  private parseWhile(): Statement {
    const start = this.take();
    const condition = this.parseExpression() ?? this.falseExpression(start.span);
    this.skipLine();
    const body = this.parseBlock(["endwhile"]);
    const end = this.current();
    if (!this.keyword("endwhile")) this.error("BP1031", "Expected EndWhile.", end.span);
    else this.skipLine();
    return { kind: "while", condition, body, span: mergeSpan(start.span, end.span) };
  }

  private parseFor(): Statement | undefined {
    const start = this.take();
    const variable = this.takeKind("identifier", "BP1032", "For expects a variable.");
    this.expect("=", "BP1033", "Expected '=' in For statement.");
    const from = this.parseExpression();
    if (!this.keyword("to"))
      this.error("BP1034", "Expected To in For statement.", this.current().span);
    else this.take();
    const to = this.parseExpression();
    let step: Expression = { kind: "literal", value: 1, span: start.span };
    if (this.keyword("step")) {
      this.take();
      step = this.parseExpression() ?? step;
    }
    this.skipLine();
    const body = this.parseBlock(["endfor"]);
    const end = this.current();
    if (!this.keyword("endfor")) this.error("BP1035", "Expected EndFor.", end.span);
    else this.skipLine();
    return variable && from && to
      ? {
          kind: "for",
          variable: variable.text,
          nameSpan: variable.span,
          start: from,
          end: to,
          step,
          body,
          span: mergeSpan(start.span, end.span),
        }
      : undefined;
  }

  private parseExpression(minimum = 0): Expression | undefined {
    let left = this.parsePrefix();
    if (!left) return undefined;
    for (;;) {
      const token = this.current();
      const operator = token.text === "!=" ? "<>" : token.text.toLowerCase();
      const precedence = binaryPrecedence.get(operator);
      if (precedence === undefined || precedence < minimum) break;
      this.take();
      const right = this.parseExpression(precedence + 1);
      if (!right) break;
      left = {
        kind: "binary",
        operator: operator as Extract<Expression, { kind: "binary" }>["operator"],
        left,
        right,
        span: mergeSpan(left.span, right.span),
      };
    }
    return left;
  }

  private parsePrefix(): Expression | undefined {
    const token = this.current();
    const lower = token.text.toLowerCase();
    if (token.text === "-" || lower === "not") {
      this.take();
      const value = this.parseExpression(6);
      return value
        ? {
            kind: "unary",
            operator: lower as "-" | "not",
            value,
            span: mergeSpan(token.span, value.span),
          }
        : undefined;
    }
    if (token.kind === "number") {
      this.take();
      return { kind: "literal", value: Number(token.value), span: token.span };
    }
    if (token.kind === "string") {
      this.take();
      return { kind: "literal", value: String(token.value), span: token.span };
    }
    if (lower === "true" || lower === "false") {
      this.take();
      return { kind: "literal", value: lower === "true", span: token.span };
    }
    if (this.match("@")) {
      const name = this.takeKind("identifier", "BP1044", "Expected a name after '@'.");
      if (!name) return undefined;
      return this.finishReference(name, true);
    }
    if (token.kind === "identifier") {
      this.take();
      return this.isText("(") ? this.finishCall(token) : this.finishReference(token, false);
    }
    if (this.match("(")) {
      const expression = this.parseExpression();
      this.expect(")", "BP1040", "Expected ')' after expression.");
      return expression;
    }
    this.error("BP1041", "Expected an expression.", token.span);
    return undefined;
  }

  private finishReference(name: Token, global: boolean): Expression | undefined {
    const reference: Expression = {
      kind: "name",
      name: name.text,
      ...(global ? { global: true } : {}),
      span: name.span,
    };
    if (!this.match("[")) return reference;
    const index = this.parseExpression();
    const end = this.current();
    this.expect("]", "BP1045", "Expected ']' after array index.");
    return index
      ? { kind: "index", array: reference, index, span: mergeSpan(name.span, end.span) }
      : undefined;
  }

  private finishCall(name: Token): Extract<Expression, { kind: "call" }> {
    this.expect("(", "BP1042", "Expected '('.");
    const args: Expression[] = [];
    while (!this.isText(")") && !this.is("eof") && !this.is("newline")) {
      const argument = this.parseExpression();
      if (argument) args.push(argument);
      if (!this.match(",")) break;
    }
    const end = this.current();
    this.expect(")", "BP1043", "Expected ')' after arguments.");
    return {
      kind: "call",
      name: name.text,
      nameSpan: name.span,
      args,
      span: mergeSpan(name.span, end.span),
    };
  }

  private falseExpression(span: SourceSpan): Expression {
    return { kind: "literal", value: false, span };
  }

  private current(): Token {
    return this.tokens[Math.min(this.#index, this.tokens.length - 1)]!;
  }

  private take(): Token {
    const token = this.current();
    if (token.kind !== "eof") this.#index += 1;
    return token;
  }

  private is(kind: Token["kind"]): boolean {
    return this.current().kind === kind;
  }

  private isText(text: string): boolean {
    // Grammar words and identifiers are ASCII. Locale negotiation per keyword
    // dominates parsing in Electron; ordinary case folding has identical semantics.
    return this.current().text.toLowerCase() === text.toLowerCase();
  }

  private keyword(text: string): boolean {
    return this.current().kind === "identifier" && this.isText(text);
  }

  private match(text: string): boolean {
    if (!this.isText(text)) return false;
    this.take();
    return true;
  }

  private expect(text: string, code: string, message: string): Token | undefined {
    if (this.isText(text)) return this.take();
    this.error(code, message, this.current().span);
    return undefined;
  }

  private takeKind(kind: Token["kind"], code: string, message: string): Token | undefined {
    if (this.is(kind)) return this.take();
    this.error(code, message, this.current().span);
    return undefined;
  }

  private skipNewlines(): void {
    while (this.is("newline")) this.take();
  }

  private skipLine(): void {
    while (!this.is("newline") && !this.is("eof")) this.take();
    this.skipNewlines();
  }

  private error(code: string, message: string, span: SourceSpan): void {
    this.diagnostics.push({
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
    });
  }
}
