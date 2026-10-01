import type { BasicPlusProjectAnalysis, BasicPlusSemanticToken } from "@kobrixa/basic-plus";
import type { CancellationToken, IDisposable, editor, languages } from "monaco-editor";

export const semanticLegend: languages.SemanticTokensLegend = {
  tokenTypes: ["namespace", "function", "method", "variable", "parameter", "label"],
  tokenModifiers: ["declaration", "defaultLibrary", "local", "global"],
};

export function encodeSemanticTokens(
  tokens: readonly BasicPlusSemanticToken[],
  model: editor.ITextModel,
  leadingBOM = false,
): Uint32Array {
  const data: number[] = [];
  let previousLine = 0;
  let previousColumn = 0;
  let endLine = -1;
  let endColumn = 0;
  for (const token of tokens) {
    const { startLine, endLine: lastLine } = token.range;
    // The compiler counts the BOM; Monaco stores it outside the first line.
    const offset = leadingBOM && startLine === 1 ? 1 : 0;
    const startColumn = token.range.startColumn - offset;
    const lastColumn = token.range.endColumn - offset;
    const line = startLine - 1;
    const column = startColumn - 1;
    const type = semanticLegend.tokenTypes.indexOf(token.type);
    if (
      type < 0 ||
      startLine < 1 ||
      startLine > model.getLineCount() ||
      lastLine !== startLine ||
      startColumn < 1 ||
      lastColumn <= startColumn ||
      lastColumn > model.getLineMaxColumn(startLine) ||
      line < endLine ||
      (line === endLine && column < endColumn)
    )
      continue;
    const modifiers = token.modifiers.reduce((bits, modifier) => {
      const index = semanticLegend.tokenModifiers.indexOf(modifier);
      return index < 0 ? bits : bits | (1 << index);
    }, 0);
    data.push(
      line - previousLine,
      line === previousLine ? column - previousColumn : column,
      lastColumn - startColumn,
      type,
      modifiers,
    );
    previousLine = line;
    previousColumn = column;
    endLine = line;
    endColumn = lastColumn - 1;
  }
  return new Uint32Array(data);
}

interface ModelTokens {
  file: string;
  subscription: IDisposable;
  version?: number | undefined;
  data: Uint32Array;
  tokens?: readonly BasicPlusSemanticToken[] | undefined;
  leadingBOM?: boolean | undefined;
  requests: Set<{
    version: number;
    resolve(tokens: languages.SemanticTokens): void;
    reject(error: Error): void;
  }>;
}
const busy = () => new Error("busy: semantic analysis was superseded");

/** Monaco tracks the last painted tokens through edits. Never replace those
 * with an empty snapshot just because a newer analysis is still running. */
export class BasicPlusSemanticTokens
  implements languages.DocumentSemanticTokensProvider, IDisposable
{
  private readonly models = new Map<editor.ITextModel, ModelTokens>();
  private readonly listeners = new Set<() => void>();
  readonly onDidChange = (listener: () => void): IDisposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };
  getLegend(): languages.SemanticTokensLegend {
    return semanticLegend;
  }
  releaseDocumentSemanticTokens(): void {}
  provideDocumentSemanticTokens(
    model: editor.ITextModel,
    _lastResultId: string | null,
    token: CancellationToken,
  ): languages.SemanticTokens | null | Promise<languages.SemanticTokens> {
    if (token.isCancellationRequested) return null;
    const state = this.models.get(model);
    if (!state || model.getLanguageId() !== "basic-plus") return { data: new Uint32Array() };
    if (state.version === model.getVersionId()) return { data: state.data };
    const version = model.getVersionId();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        state.requests.delete(request);
        cancellation.dispose();
      };
      const request = {
        version,
        resolve: (tokens: languages.SemanticTokens) => {
          cleanup();
          resolve(tokens);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const cancellation = token.onCancellationRequested(() => request.reject(busy()));
      state.requests.add(request);
    });
  }
  bind(model: editor.ITextModel, file: string): void {
    const existing = this.models.get(model);
    if (existing) {
      if (existing.file === file) return;
      existing.file = file;
      for (const request of existing.requests) request.reject(busy());
      existing.data = new Uint32Array();
      existing.tokens = undefined;
      existing.version = model.getVersionId();
      this.fire();
      return;
    }
    const state: ModelTokens = {
      file,
      data: new Uint32Array(),
      requests: new Set(),
      subscription: model.onDidChangeContent(() => {
        // A pending request belongs to its start version. Returning tokens for a
        // later version would make Monaco apply the intervening edits twice.
        for (const request of state.requests)
          if (request.version !== model.getVersionId()) request.reject(busy());
      }),
    };
    this.models.set(model, state);
  }
  unbind(model: editor.ITextModel): void {
    const state = this.models.get(model);
    if (!state) return;
    state.subscription.dispose();
    for (const request of state.requests) request.reject(busy());
    this.models.delete(model);
  }
  update(
    tokensByFile: BasicPlusProjectAnalysis["tokensByFile"] | undefined,
    sources?: Record<string, string>,
    versions?: ReadonlyMap<editor.ITextModel, number>,
  ): void {
    if (
      versions &&
      [...this.models].some(
        ([model, state]) =>
          model.getLanguageId() === "basic-plus" &&
          (tokensByFile?.[state.file] !== undefined || sources?.[state.file] !== undefined) &&
          versions.get(model) !== model.getVersionId(),
      )
    )
      return;
    let changed = false;
    for (const [model, state] of this.models) {
      const tokens = tokensByFile?.[state.file];
      const leadingBOM = sources?.[state.file]?.startsWith("\uFEFF");
      const data =
        tokens && state.tokens === tokens && state.leadingBOM === leadingBOM
          ? state.data
          : tokens
            ? encodeSemanticTokens(tokens, model, leadingBOM)
            : new Uint32Array();
      state.tokens = tokens;
      state.leadingBOM = leadingBOM;
      if (data.length !== state.data.length || data.some((value, i) => value !== state.data[i])) {
        state.data = data;
        changed = true;
      }
      state.version = model.getVersionId();
      for (const request of state.requests) {
        if (request.version === state.version) request.resolve({ data: state.data });
        else request.reject(busy());
      }
    }
    if (changed) this.fire();
  }
  /** A failed analysis falls back only for documents edited since their last result. */
  fail(): void {
    let changed = false;
    for (const [model, state] of this.models)
      if (state.version !== model.getVersionId()) {
        state.data = new Uint32Array();
        state.tokens = undefined;
        state.version = model.getVersionId();
        changed = true;
        for (const request of state.requests) request.resolve({ data: state.data });
      }
    if (changed) this.fire();
  }
  private fire(): void {
    for (const listener of this.listeners) listener();
  }
  dispose(): void {
    for (const model of this.models.keys()) this.unbind(model);
    this.listeners.clear();
  }
}
