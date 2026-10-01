import path from "node:path";
import type { Diagnostic, SourceProject } from "@kobrixa/compiler";
import type { FunctionDeclaration, ParsedFile, Statement } from "./ast.js";
import { parse } from "./parser.js";

export class BasicPlusParseCache {
  private readonly files = new Map<string, { content: string; result: ReturnType<typeof parse> }>();
  readonly parsedFiles: string[] = [];
  begin(paths: Set<string>): void {
    this.parsedFiles.length = 0;
    for (const file of this.files.keys()) if (!paths.has(file)) this.files.delete(file);
  }
  parse(file: string, content: string): ReturnType<typeof parse> {
    const cached = this.files.get(file);
    if (cached?.content === content) return cached.result;
    const result = parse(file, content);
    this.files.set(file, { content, result });
    this.parsedFiles.push(file);
    return result;
  }
}

function includeDiagnostic(
  code: string,
  message: string,
  include: ParsedFile["includes"][number],
): Diagnostic {
  return {
    code,
    severity: "error",
    file: include.span.file,
    range: {
      startLine: include.span.start.line,
      startColumn: include.span.start.column,
      endLine: include.span.end.line,
      endColumn: include.span.end.column,
    },
    message,
  };
}

/** Parse once; every entry uses exactly the compiler's include/import resolution. */
export function prepareBasicPlusProject(
  input: SourceProject,
  signal: AbortSignal,
  cache?: BasicPlusParseCache,
) {
  signal.throwIfAborted();
  const diagnostics: Diagnostic[] = [];
  const parsed = new Map<string, ParsedFile>();
  const parsedByCaseInsensitivePath = new Map<string, string>();
  cache?.begin(new Set(input.sources.map((source) => source.path.replaceAll("\\", "/"))));
  for (const source of input.sources) {
    signal.throwIfAborted();
    const key = source.path.replaceAll("\\", "/");
    const result = cache ? cache.parse(key, source.content) : parse(key, source.content);
    parsed.set(key, result.parsed);
    parsedByCaseInsensitivePath.set(key.toLocaleLowerCase("en-US"), key);
    diagnostics.push(...result.diagnostics);
  }
  const resolve = (
    entry: string,
  ): {
    rootFile?: ParsedFile;
    diagnostics: Diagnostic[];
    body: Statement[];
    functions: FunctionDeclaration[];
    sourceFiles: string[];
  } => {
    entry = entry.replaceAll("\\", "/");
    const diagnostics: Diagnostic[] = [];
    const rootFile = parsed.get(entry);
    if (!rootFile) {
      diagnostics.push({
        code: "BP1000",
        severity: "error",
        file: entry,
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
        message: "Entry source was not loaded.",
      });
      return { diagnostics, body: [], functions: [], sourceFiles: [] };
    }

    const body: Statement[] = [];
    const functions: FunctionDeclaration[] = [];
    const visited = new Set<string>();
    const active = new Set<string>();
    const visit = (file: ParsedFile): void => {
      signal.throwIfAborted();
      if (visited.has(file.file)) return;
      active.add(file.file);
      for (const include of file.includes) {
        const includePathText = include.path.replaceAll("\\", "/");
        const requestedPath = path.posix.normalize(
          path.posix.join(path.posix.dirname(file.file), includePathText),
        );
        if (
          requestedPath === ".." ||
          requestedPath.startsWith("../") ||
          path.posix.isAbsolute(requestedPath)
        ) {
          diagnostics.push(
            includeDiagnostic("BP1101", "Include path escapes the project root.", include),
          );
          continue;
        }
        const candidates = path.posix.extname(requestedPath)
          ? [requestedPath]
          : [`${requestedPath}.${include.kind === "import" ? "bpm" : "bpi"}`, requestedPath];
        const includePath =
          candidates.find((candidate) => parsed.has(candidate)) ??
          candidates
            .map((candidate) =>
              parsedByCaseInsensitivePath.get(candidate.toLocaleLowerCase("en-US")),
            )
            .find((candidate): candidate is string => candidate !== undefined) ??
          candidates[0]!;
        if (active.has(includePath)) {
          // Clev3r treats an import already being processed as a no-op.  This
          // is used by its module templates, including a module importing its
          // own public declarations.
          continue;
        }
        const included = parsed.get(includePath);
        if (!included) {
          diagnostics.push(
            includeDiagnostic("BP1100", `Included file '${includePath}' was not found.`, include),
          );
          continue;
        }
        visit(included);
      }
      active.delete(file.file);
      visited.add(file.file);
      body.push(...file.body);
      functions.push(...file.functions);
    };
    visit(rootFile);
    return { rootFile, body, functions, sourceFiles: [...visited], diagnostics };
  };
  return { parsed, diagnostics, resolve };
}
