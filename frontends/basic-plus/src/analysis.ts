import type { Diagnostic, SourceProject, SourceRange } from "@kobrixa/compiler";
import { getEV3Operation, type SourceSpan, type IRType, type KobrixaIR } from "@kobrixa/ir";
import type { Expression, FunctionDeclaration, Statement, ParsedFile } from "./ast.js";
import { lowerProgram } from "./lower.js";
import { BasicPlusParseCache, prepareBasicPlusProject } from "./project.js";
import { canonical, functionSymbols, resolveVariable } from "./symbols.js";
import { BASIC_PLUS_API_COMPLETIONS } from "./language.js";
import {
  emptySymbolIndex,
  type BasicPlusSymbolIndex,
  type BasicPlusSymbol,
  type BasicPlusLocation,
  type BasicPlusOccurrence,
} from "./symbol-index.js";
export type * from "./symbol-index.js";

export type BasicPlusTokenType =
  "namespace" | "function" | "method" | "variable" | "parameter" | "label";
export type BasicPlusTokenModifier = "declaration" | "defaultLibrary" | "local" | "global";
export interface BasicPlusSemanticToken {
  range: SourceRange;
  type: BasicPlusTokenType;
  modifiers: BasicPlusTokenModifier[];
}
export interface BasicPlusProjectAnalysis {
  diagnostics: Diagnostic[];
  index: BasicPlusSymbolIndex;
  tokensByFile: Record<string, BasicPlusSemanticToken[]>;
}

type Binding = { scope: "parameter" | "local" | "global"; symbol: BasicPlusSymbol };
function typeName(type: IRType | undefined): string {
  return !type
    ? "unknown"
    : type.kind === "array"
      ? `${type.element}[]`
      : type.kind === "integer"
        ? "number"
        : type.kind;
}
function location(span: SourceSpan): BasicPlusLocation {
  return {
    file: span.file,
    range: {
      startLine: span.start.line,
      startColumn: span.start.column,
      endLine: span.end.line,
      endColumn: span.end.column,
    },
  };
}

/** A tolerant binding walk: no IR is required to color a partially edited document. */
function semanticTokens(
  body: Statement[],
  declarations: FunctionDeclaration[],
  signal: AbortSignal,
  index: BasicPlusSymbolIndex,
  context: string,
  ir?: KobrixaIR,
  completionOnly = false,
): Map<string, BasicPlusSemanticToken[]> {
  const result = new Map<string, Map<number, BasicPlusSemanticToken>>();
  const known = functionSymbols(declarations);
  const globals = new Map<string, Binding>();
  const functionIds = new Map<FunctionDeclaration, BasicPlusSymbol>();
  const occurrences = new Map<string, BasicPlusOccurrence>();
  const rootScope = `${context}:global`;
  const addSymbol = (
    name: string,
    kind: BasicPlusSymbol["kind"],
    scope: BasicPlusSymbol["scope"],
    scopeId: string,
    span?: SourceSpan,
    type = "unknown",
  ): BasicPlusSymbol => {
    const base = JSON.stringify([context, scopeId, kind, span?.file ?? "", canonical(name)]);
    let id = base;
    let duplicate = 1;
    while (index.symbols[id]) id = `${base}#${++duplicate}`;
    const symbol: BasicPlusSymbol = {
      id,
      context,
      name,
      kind,
      scope,
      scopeId,
      type,
      aliases: [name],
      ...(span ? { declaration: location(span) } : {}),
    };
    index.symbols[id] = symbol;
    return symbol;
  };
  const occurrence = (
    symbol: BasicPlusSymbol,
    span: SourceSpan | undefined,
    declaration = false,
  ) => {
    if (completionOnly || !span) return;
    const key = `${span.file}:${span.start.offset}:${symbol.id}`;
    occurrences.set(key, {
      ...location(span),
      symbolId: symbol.id,
      context,
      declaration: declaration || occurrences.get(key)?.declaration === true,
    });
  };
  for (const declaration of declarations) {
    const symbol = addSymbol(
      declaration.name,
      declaration.kind,
      "global",
      rootScope,
      declaration.nameSpan,
      declaration.kind === "sub" ? "void" : typeName(declaration.returnType),
    );
    symbol.parameters = declaration.parameters.map((p) => ({
      name: p.name,
      direction: p.direction,
      type: typeName(p.type),
    }));
    symbol.aliases = [...known]
      .filter(([, value]) => value === declaration)
      .map(([alias]) => (alias === canonical(declaration.name) ? declaration.name : alias));
    functionIds.set(declaration, symbol);
  }
  const builtinSymbols = new Map<string, BasicPlusSymbol>();
  const builtin = (name: string): BasicPlusSymbol => {
    const key = canonical(name);
    let symbol = builtinSymbols.get(key);
    if (!symbol) {
      const operation = getEV3Operation(name);
      symbol = addSymbol(
        operation?.name ?? name,
        "method",
        "builtin",
        "builtin",
        undefined,
        operation
          ? typeName(
              typeof operation.returns === "string"
                ? { kind: operation.returns }
                : operation.returns,
            )
          : "void",
      );
      symbol.parameters =
        operation?.parameters.map((type, i) => ({
          name: `arg${i + 1}`,
          direction: "in",
          type: Array.isArray(type) ? type.join(" | ") : String(type),
        })) ?? [];
      symbol.documentation =
        BASIC_PLUS_API_COMPLETIONS.find((c) => canonical(c.label) === key)?.documentation ??
        "Starts a parameterless Sub in a background thread.";
      builtinSymbols.set(key, symbol);
    }
    return symbol;
  };
  const globalLabels = labels(body, rootScope, "global");
  function emit(
    span: SourceSpan | undefined,
    type: BasicPlusTokenType,
    modifiers: BasicPlusTokenModifier[] = [],
  ) {
    if (
      completionOnly ||
      !span ||
      span.start.line !== span.end.line ||
      span.end.column <= span.start.column
    )
      return;
    let tokens = result.get(span.file);
    if (!tokens) result.set(span.file, (tokens = new Map()));
    const previous = tokens.get(span.start.offset);
    tokens.set(span.start.offset, {
      range: {
        startLine: span.start.line,
        startColumn: span.start.column,
        endLine: span.end.line,
        endColumn: span.end.column,
      },
      type,
      modifiers: [...new Set([...(previous?.modifiers ?? []), ...modifiers])],
    });
  }
  const builtinSymbol = builtin;
  function callable(name: string, span: SourceSpan | undefined, builtin: boolean) {
    if (completionOnly || !span) return;
    const declaration = known.get(canonical(name));
    const symbol = builtin
      ? builtinSymbol(name)
      : declaration
        ? functionIds.get(declaration)
        : undefined;
    // Only filename-qualified calls lose their prefix when the function is renamed.
    const declaredName = (builtin ? undefined : declaration?.name) ?? name.split(".").at(-1)!;
    const suffix = name.length - declaredName.length;
    if (symbol)
      occurrence(symbol, {
        ...span,
        start: {
          ...span.start,
          column: span.start.column + suffix,
          offset: span.start.offset + suffix,
        },
      });
    const dot = name.lastIndexOf(".");
    const modifiers: BasicPlusTokenModifier[] = builtin ? ["defaultLibrary"] : [];
    if (dot >= 0) {
      emit(
        {
          ...span,
          end: { ...span.start, column: span.start.column + dot, offset: span.start.offset + dot },
        },
        "namespace",
        modifiers,
      );
      emit(
        {
          ...span,
          start: {
            ...span.start,
            column: span.start.column + dot + 1,
            offset: span.start.offset + dot + 1,
          },
        },
        builtin ? "method" : "function",
        modifiers,
      );
    } else emit(span, builtin ? "method" : "function", modifiers);
  }
  function labels(statements: Statement[], scopeId: string, scope: "local" | "global") {
    const result = new Map<string, BasicPlusSymbol>();
    for (const statement of statements)
      if (statement.kind === "label") {
        const key = canonical(statement.label);
        if (!result.has(key))
          result.set(
            key,
            addSymbol(statement.label, "label", scope, scopeId, statement.nameSpan, "label"),
          );
      }
    return result;
  }
  function walk(
    statements: Statement[],
    parameters: FunctionDeclaration["parameters"],
    globalScope: boolean,
    owner?: FunctionDeclaration,
  ) {
    const locals = new Map<string, Binding>();
    const scopeId = owner ? functionIds.get(owner)!.id : rootScope;
    index.scopes.push({
      id: scopeId,
      context,
      ...(owner ? { location: location(owner.span) } : {}),
    });
    const localLabels = globalScope ? globalLabels : labels(statements, scopeId, "local");
    const lowered = ir?.functions.find(
      (fn) => fn.name === (owner ? canonical(owner.name) : "main"),
    );
    for (const parameter of parameters) {
      const symbol = addSymbol(
        parameter.name,
        "parameter",
        "parameter",
        scopeId,
        parameter.nameSpan,
        typeName(parameter.type),
      );
      locals.set(canonical(parameter.name), { scope: "parameter", symbol });
      occurrence(symbol, parameter.nameSpan, true);
      emit(parameter.nameSpan, "parameter", ["declaration"]);
    }
    function variable(
      name: string,
      span: SourceSpan | undefined,
      forceGlobal = false,
      declaration = false,
      inferred = "unknown",
    ) {
      let created = false;
      const binding = resolveVariable(
        name,
        locals,
        globals,
        forceGlobal || globalScope,
        (_key, scope) => {
          created = true;
          const storage = scope === "global" ? ir?.globals : lowered?.locals;
          const type = storage?.find((v) => v.name === canonical(name))?.type;
          return {
            scope,
            symbol: addSymbol(
              name,
              "variable",
              scope,
              scope === "global" ? rootScope : scopeId,
              span,
              type ? typeName(type) : inferred,
            ),
          };
        },
      );
      if (binding.symbol.type === "unknown" && inferred !== "unknown")
        binding.symbol.type = inferred;
      occurrence(binding.symbol, span, created || declaration);
      const modifiers: BasicPlusTokenModifier[] =
        binding.scope === "parameter" ? [] : [binding.scope];
      if (created || declaration) modifiers.unshift("declaration");
      emit(span, binding.scope === "parameter" ? "parameter" : "variable", modifiers);
    }
    function infer(value: Expression): string {
      switch (value.kind) {
        case "literal":
          return typeof value.value === "number" ? "number" : typeof value.value;
        case "name":
          return (
            locals.get(canonical(value.name))?.symbol.type ??
            globals.get(canonical(value.name))?.symbol.type ??
            "unknown"
          );
        case "call": {
          const op = getEV3Operation(value.name);
          return op
            ? typeName(typeof op.returns === "string" ? { kind: op.returns } : op.returns)
            : typeName(known.get(canonical(value.name))?.returnType);
        }
        case "unary":
          return value.operator === "not" ? "boolean" : "number";
        case "binary":
          return ["=", "<>", "<", "<=", ">", ">=", "and", "or"].includes(value.operator)
            ? "boolean"
            : value.operator === "+" && [infer(value.left), infer(value.right)].includes("string")
              ? "string"
              : "number";
        case "index":
          return infer(value.array).replace(/\[\]$/, "");
      }
    }
    function expression(value: Expression) {
      signal.throwIfAborted();
      switch (value.kind) {
        case "name": {
          const operation = getEV3Operation(value.name);
          if (operation?.parameters.length === 0) callable(value.name, value.span, true);
          else variable(value.name, value.span, value.global);
          break;
        }
        case "call": {
          const operation = getEV3Operation(value.name);
          if (operation || known.has(canonical(value.name)))
            callable(value.name, value.nameSpan, Boolean(operation));
          // Like lowering, arguments introduce implicit bindings from left to right.
          value.args.forEach(expression);
          break;
        }
        case "index":
          expression(value.array);
          expression(value.index);
          break;
        case "unary":
          expression(value.value);
          break;
        case "binary":
          expression(value.left);
          expression(value.right);
          break;
        case "literal":
          break;
      }
    }
    function statementsIn(items: Statement[]) {
      for (const statement of items) {
        signal.throwIfAborted();
        switch (statement.kind) {
          case "assign":
            expression(statement.value);
            variable(
              statement.name,
              statement.nameSpan,
              statement.global,
              false,
              infer(statement.value),
            );
            break;
          case "declaration":
            variable(
              statement.name,
              statement.nameSpan,
              globalScope,
              true,
              typeName(statement.type),
            );
            break;
          case "property":
            variable(statement.name, statement.nameSpan, false, true, "number");
            break;
          case "array-assign":
            expression(statement.value);
            expression(statement.array);
            expression(statement.index);
            break;
          case "call":
            expression(statement.call);
            break;
          case "thread-run":
            callable("Thread.Run", statement.operationSpan, true);
            if (known.has(canonical(statement.functionName)))
              callable(statement.functionName, statement.nameSpan, false);
            break;
          case "if":
            for (const branch of statement.branches) {
              expression(branch.condition);
              statementsIn(branch.body);
            }
            statementsIn(statement.otherwise);
            break;
          case "while":
            expression(statement.condition);
            statementsIn(statement.body);
            break;
          case "for":
            expression(statement.start);
            variable(statement.variable, statement.nameSpan, false, false, "number");
            expression(statement.end);
            statementsIn(statement.body);
            expression(statement.step);
            break;
          case "return":
            if (statement.value) expression(statement.value);
            break;
          case "label": {
            let label = localLabels.get(canonical(statement.label));
            if (!label) {
              label = addSymbol(
                statement.label,
                "label",
                globalScope ? "global" : "local",
                scopeId,
                statement.nameSpan,
                "label",
              );
              localLabels.set(canonical(statement.label), label);
            }
            occurrence(label, statement.nameSpan, true);
            emit(statement.nameSpan, "label", ["declaration"]);
            break;
          }
          case "goto": {
            const label =
              localLabels.get(canonical(statement.label)) ??
              globalLabels.get(canonical(statement.label));
            if (label) occurrence(label, statement.nameSpan);
            if (
              localLabels.has(canonical(statement.label)) ||
              globalLabels.has(canonical(statement.label))
            )
              emit(statement.nameSpan, "label");
            break;
          }
          case "break":
          case "continue":
            break;
        }
      }
    }
    statementsIn(statements);
  }
  walk(body, [], true);
  for (const declaration of declarations) {
    emit(declaration.nameSpan, "function", ["declaration"]);
    occurrence(functionIds.get(declaration)!, declaration.nameSpan, true);
    walk(declaration.body, declaration.parameters, false, declaration);
  }
  for (const item of occurrences.values()) (index.occurrencesByFile[item.file] ??= []).push(item);
  return new Map(
    [...result].map(([file, tokens]) => [
      file,
      [...tokens].sort(([a], [b]) => a - b).map(([, token]) => token),
    ]),
  );
}

interface ContextAnalysis {
  files: string[];
  parsed: ParsedFile[];
  resolutionKey: string;
  canLower: boolean;
  index: BasicPlusSymbolIndex;
  tokens: Map<string, BasicPlusSemanticToken[]>;
  diagnostics: Diagnostic[];
}

/** A workspace-owned cache. Binding is invalidated per dependency closure, since
 * implicit globals and include order can affect every function in that closure. */
export class BasicPlusProjectAnalyzer {
  constructor(private readonly completionOnly = false) {}
  readonly completionGuards: Record<string, SourceRange[]> = Object.create(null);
  private parser = new BasicPlusParseCache();
  private readonly contexts = new Map<string, ContextAnalysis>();
  private projectKey = "";
  readonly lastRun: { parsedFiles: string[]; analyzedContexts: string[] } = {
    parsedFiles: [],
    analyzedContexts: [],
  };

  analyze(input: SourceProject, signal: AbortSignal): BasicPlusProjectAnalysis {
    const projectKey = JSON.stringify([input.root, input.manifest.name]);
    if (this.projectKey !== projectKey) {
      this.projectKey = projectKey;
      this.contexts.clear();
      this.parser = new BasicPlusParseCache();
    }
    const prepared = prepareBasicPlusProject(input, signal, this.parser);
    if (this.completionOnly) {
      for (const file of Object.keys(this.completionGuards)) delete this.completionGuards[file];
      for (const [file, parsed] of prepared.parsed) {
        const lines = new Set([
          ...parsed.includes.map((item) => item.span.start.line),
          ...parsed.functions.flatMap((fn) => [fn.span.start.line, fn.span.end.line]),
        ]);
        this.completionGuards[file] = [...lines].map((line) => ({
          startLine: line,
          startColumn: 1,
          endLine: line,
          endColumn: 1,
        }));
      }
    }
    this.lastRun.parsedFiles = [...this.parser.parsedFiles];
    this.lastRun.analyzedContexts = [];
    const used = new Set<string>();
    const context = input.manifest.entry.replaceAll("\\", "/");
    const analyzeContext = (file: string, main: boolean): ContextAnalysis => {
      signal.throwIfAborted();
      used.add(file);
      const program = prepared.resolve(file);
      const parsed = program.sourceFiles.map((path) => prepared.parsed.get(path)!);
      const errors = [
        ...program.diagnostics,
        ...prepared.diagnostics.filter((d) => main || program.sourceFiles.includes(d.file)),
      ];
      const canLower = !errors.some((d) => d.severity === "error");
      const resolutionKey = JSON.stringify(program.diagnostics);
      const previous = this.contexts.get(file);
      if (
        previous &&
        previous.canLower === canLower &&
        previous.resolutionKey === resolutionKey &&
        previous.parsed.length === parsed.length &&
        parsed.every((item, i) => item === previous.parsed[i])
      )
        return previous;
      this.lastRun.analyzedContexts.push(file);
      let ir: KobrixaIR | undefined;
      const diagnostics: Diagnostic[] = [];
      // Lowering infers returnType on declarations. Keep the parsed AST immutable
      // so one root's cached results cannot contaminate another root or revision.
      const functions = program.functions.map((fn) => ({ ...fn }));
      if (canLower && !this.completionOnly) {
        try {
          const lowered = lowerProgram(
            input.manifest.name,
            program.body,
            functions,
            program.sourceFiles,
          );
          ir = lowered.ir;
          diagnostics.push(...lowered.diagnostics);
        } catch (error) {
          signal.throwIfAborted();
          diagnostics.push({
            code: "BP0000",
            severity: "error",
            file,
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
            message: `Unable to complete analysis: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      signal.throwIfAborted();
      const index = emptySymbolIndex();
      index.contextFiles[file] = program.sourceFiles;
      if (!canLower || diagnostics.some((d) => d.severity === "error"))
        index.invalidContexts.push(file);
      const tokens = semanticTokens(
        program.body,
        functions,
        signal,
        index,
        file,
        ir,
        this.completionOnly,
      );
      const result = {
        files: program.sourceFiles,
        parsed,
        resolutionKey,
        canLower,
        index,
        tokens,
        diagnostics: [...program.diagnostics, ...diagnostics],
      };
      this.contexts.set(file, result);
      return result;
    };
    const main = analyzeContext(context, true);
    const diagnostics = [...prepared.diagnostics, ...main.diagnostics];
    const index = emptySymbolIndex();
    for (const source of this.completionOnly ? [] : input.sources)
      index.sources[source.path.replaceAll("\\", "/")] = source.content;
    const tokensByFile: BasicPlusProjectAnalysis["tokensByFile"] = Object.create(null);
    const merge = (result: ContextAnalysis) => {
      Object.assign(index.symbols, result.index.symbols);
      Object.assign(index.contextFiles, result.index.contextFiles);
      index.scopes.push(...result.index.scopes);
      index.invalidContexts.push(...result.index.invalidContexts);
      for (const [file, items] of Object.entries(result.index.occurrencesByFile))
        (index.occurrencesByFile[file] ??= []).push(...items);
    };
    merge(main);
    const reachable = new Set(main.files);
    for (const file of prepared.parsed.keys()) {
      signal.throwIfAborted();
      if (reachable.has(file)) {
        index.fileContexts[file] = context;
        tokensByFile[file] = main.tokens.get(file) ?? [];
      } else {
        const isolated = analyzeContext(file, false);
        merge(isolated);
        index.fileContexts[file] = file;
        tokensByFile[file] = isolated.tokens.get(file) ?? [];
      }
    }
    for (const key of this.contexts.keys()) if (!used.has(key)) this.contexts.delete(key);
    for (const occurrences of Object.values(index.occurrencesByFile))
      occurrences.sort(
        (a, b) =>
          a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn,
      );
    signal.throwIfAborted();
    return { diagnostics, tokensByFile, index };
  }
}

export function analyzeBasicPlusProject(
  input: SourceProject,
  signal: AbortSignal,
): BasicPlusProjectAnalysis {
  return new BasicPlusProjectAnalyzer().analyze(input, signal);
}

/** Names and scopes share the semantic binder, without IR, tokens or references. */
export type BasicPlusCompletionIndex = Pick<
  BasicPlusSymbolIndex,
  "symbols" | "scopes" | "fileContexts" | "contextFiles"
> & { guardsByFile: Record<string, SourceRange[]> };
export class BasicPlusCompletionAnalyzer {
  private readonly analyzer = new BasicPlusProjectAnalyzer(true);
  get lastRun() {
    return this.analyzer.lastRun;
  }
  analyze(project: SourceProject, signal: AbortSignal): BasicPlusCompletionIndex {
    const { symbols, scopes, fileContexts, contextFiles } = this.analyzer.analyze(
      project,
      signal,
    ).index;
    return {
      symbols,
      scopes,
      fileContexts,
      contextFiles,
      guardsByFile: { ...this.analyzer.completionGuards },
    };
  }
}
