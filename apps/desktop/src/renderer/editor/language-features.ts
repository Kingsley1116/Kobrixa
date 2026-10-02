import type { BasicPlusSymbol } from "@kobrixa/basic-plus";
import * as monaco from "monaco-editor";
import {
  BASIC_PLUS_API_COMPLETIONS,
  BASIC_PLUS_KEYWORDS,
  BASIC_PLUS_INDENTATION_RULES,
} from "@kobrixa/basic-plus/language";
import { basicPlusRangeFormattingEdits } from "./basic-plus-formatting.js";
import {
  editingContext,
  occurrenceAt,
  prepareSymbolRename,
  symbolReferences,
  symbolSignature,
  visibleSymbols,
} from "@kobrixa/basic-plus/intelligence";
import { rememberRename } from "./workspace-edits.js";
import type { EditorAnalysis } from "./editor.js";
import type { SourceRange } from "@kobrixa/compiler";

export const normalizeSource = (value: string): string =>
  value.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
export function editorRange(range: SourceRange, source: string): monaco.Range {
  const bom = source.startsWith("\uFEFF");
  return new monaco.Range(
    range.startLine,
    range.startColumn - (bom && range.startLine === 1 ? 1 : 0),
    range.endLine,
    range.endColumn - (bom && range.endLine === 1 ? 1 : 0),
  );
}
interface FeatureHost {
  fileFor(model: monaco.editor.ITextModel): string | undefined;
  ensureModel(file: string, content: string): monaco.editor.ITextModel;
  canEdit(): boolean;
  isCurrent(model: monaco.editor.ITextModel, file: string, snapshot: EditorAnalysis): boolean;
  completionSymbols?(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): BasicPlusSymbol[] | undefined;
  refreshCompletions?(model: monaco.editor.ITextModel, position: monaco.Position): void;
}

/** Monaco adapter only; parsing and symbol binding stay in the background worker. */
export class BasicPlusLanguageFeatures implements monaco.IDisposable {
  private snapshot: EditorAnalysis | undefined;
  private readonly changed = new Set<() => void>();
  private readonly registrations: monaco.IDisposable[] = [];
  private disposed = false;
  private pendingCompletion:
    { model: monaco.editor.ITextModel; version: number; position: monaco.Position } | undefined;
  constructor(private readonly host: FeatureHost) {}
  update(snapshot: EditorAnalysis | undefined): void {
    this.snapshot = snapshot;
    for (const listener of this.changed) listener();
    const pending = this.pendingCompletion;
    if (snapshot && pending) {
      this.pendingCompletion = undefined;
      if (
        !pending.model.isDisposed() &&
        pending.version === pending.model.getVersionId() &&
        this.current(pending.model)
      )
        this.host.refreshCompletions?.(pending.model, pending.position);
    }
  }
  refreshCompletion(): void {
    const pending = this.pendingCompletion;
    if (pending && !pending.model.isDisposed() && pending.version === pending.model.getVersionId())
      this.host.refreshCompletions?.(pending.model, pending.position);
  }
  private current(
    model: monaco.editor.ITextModel,
  ): { snapshot: EditorAnalysis; file: string } | undefined {
    const file = this.host.fileFor(model);
    const snapshot = this.snapshot;
    if (!file || !snapshot || !this.host.isCurrent(model, file, snapshot)) return undefined;
    return { snapshot, file };
  }
  private async ready(model: monaco.editor.ITextModel, token: monaco.CancellationToken) {
    if (model.isDisposed() || this.disposed || token.isCancellationRequested) return;
    const version = model.getVersionId();
    const current = this.current(model);
    if (current || token.isCancellationRequested || this.disposed)
      return token.isCancellationRequested ? undefined : current;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.changed.delete(check);
        cancellation?.dispose();
        resolve();
      };
      const check = () => {
        if (
          this.disposed ||
          token.isCancellationRequested ||
          model.isDisposed() ||
          version !== model.getVersionId() ||
          this.current(model)
        )
          finish();
      };
      const timer = setTimeout(finish, 2000);
      this.changed.add(check);
      const cancellation = token.onCancellationRequested(finish);
      check();
    });
    return !this.disposed &&
      !token.isCancellationRequested &&
      !model.isDisposed() &&
      version === model.getVersionId()
      ? this.current(model)
      : undefined;
  }
  private at(
    current: NonNullable<ReturnType<BasicPlusLanguageFeatures["current"]>>,
    position: monaco.Position,
  ) {
    const { snapshot, file } = current;
    const column =
      position.column +
      (position.lineNumber === 1 && snapshot.analysis.index.sources[file]!.startsWith("\uFEFF")
        ? 1
        : 0);
    const occurrence = occurrenceAt(snapshot.analysis.index, file, position.lineNumber, column);
    return {
      column,
      occurrence,
      symbol: occurrence && snapshot.analysis.index.symbols[occurrence.symbolId],
    };
  }
  register(): void {
    const selector = { language: "basic-plus", scheme: "kobrixa" };
    this.registrations.push(
      monaco.languages.registerCompletionItemProvider(selector, {
        triggerCharacters: [".", "@"],
        provideCompletionItems: (m, p, _c, t) => this.completions(m, p, t),
      }),
      monaco.languages.registerHoverProvider(selector, {
        provideHover: (m, p, t) => this.hover(m, p, t),
      }),
      monaco.languages.registerSignatureHelpProvider(selector, {
        signatureHelpTriggerCharacters: ["(", ","],
        signatureHelpRetriggerCharacters: [")"],
        provideSignatureHelp: (m, p, t) => this.signature(m, p, t),
      }),
      monaco.languages.registerDefinitionProvider(selector, {
        provideDefinition: (m, p, t) => this.definition(m, p, t),
      }),
      monaco.languages.registerReferenceProvider(selector, {
        provideReferences: (m, p, c, t) => this.references(m, p, c.includeDeclaration, t),
      }),
      monaco.languages.registerRenameProvider(selector, {
        resolveRenameLocation: (m, p, t) => this.renameLocation(m, p, t),
        provideRenameEdits: (m, p, n, t) => this.rename(m, p, n, t),
      }),
    );
  }
  async completions(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.CompletionList> {
    if (model.isDisposed() || token.isCancellationRequested || this.disposed)
      return { suggestions: [] };
    const version = model.getVersionId();
    const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    if (editingContext(before).inLiteral) return { suggestions: [] };
    const prefix = before.match(/[A-Za-z_][\w.]*$/)?.[0] ?? "";
    const after =
      model
        .getLineContent(position.lineNumber)
        .slice(position.column - 1)
        .match(/^[\w.]*/)?.[0] ?? "";
    const range = new monaco.Range(
      position.lineNumber,
      position.column - prefix.length,
      position.lineNumber,
      position.column + after.length,
    );
    const normalized = prefix.toLowerCase();
    const suggestions: monaco.languages.CompletionItem[] = [];
    const current = this.current(model);
    if (token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId())
      return { suggestions: [] };
    if (!current) this.pendingCompletion = { model, version, position };
    const cached = this.host.completionSymbols?.(model, position);
    const candidates = current
      ? visibleSymbols(
          current.snapshot.analysis.index,
          current.file,
          position.lineNumber,
          position.column +
            (position.lineNumber === 1 &&
            current.snapshot.analysis.index.sources[current.file]?.startsWith("\uFEFF")
              ? 1
              : 0),
        )
      : (cached ?? []);
    {
      for (const symbol of candidates) {
        for (const label of symbol.aliases) {
          if (!label.toLowerCase().startsWith(normalized)) continue;
          suggestions.push({
            label,
            range,
            insertText: label,
            kind:
              symbol.kind === "parameter" || symbol.kind === "variable"
                ? monaco.languages.CompletionItemKind.Variable
                : symbol.kind === "label"
                  ? monaco.languages.CompletionItemKind.Reference
                  : monaco.languages.CompletionItemKind.Function,
            detail: symbolSignature(symbol, label),
            sortText: `0-${label.toLowerCase()}`,
          });
        }
      }
    }
    if (!prefix.includes(".")) {
      const line = model.getLineContent(position.lineNumber);
      const leading = before.slice(0, range.startColumn - 1);
      let closingIndent: string | undefined;
      for (const label of BASIC_PLUS_KEYWORDS)
        if (label.toLowerCase().startsWith(normalized)) {
          const item: monaco.languages.CompletionItem = {
            label,
            range,
            insertText: label,
            kind: monaco.languages.CompletionItemKind.Keyword,
            sortText: `2-${label}`,
          };
          if (
            /^[\t ]*$/.test(leading) &&
            BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(label) &&
            !BASIC_PLUS_INDENTATION_RULES.decreaseIndentPattern.test(line)
          ) {
            // Suggestions bypass Monaco's typing indentation. Include whitespace
            // in the same completion edit so acceptance and undo stay atomic.
            // All closing/branch candidates at this position have the same depth.
            closingIndent ??=
              basicPlusRangeFormattingEdits(
                {
                  getLineContent: (number) =>
                    number === position.lineNumber
                      ? leading + label + line.slice(range.endColumn - 1)
                      : model.getLineContent(number),
                },
                range,
                model.getOptions(),
                token,
              )[0]?.text ?? leading;
            if (closingIndent !== leading) {
              item.range = new monaco.Range(
                position.lineNumber,
                1,
                position.lineNumber,
                range.endColumn,
              );
              item.insertText = closingIndent + label;
              item.filterText = leading + label;
            }
          }
          suggestions.push(item);
        }
    }
    for (const api of BASIC_PLUS_API_COMPLETIONS)
      if (api.label.toLowerCase().startsWith(normalized))
        suggestions.push({
          label: api.label,
          range,
          kind: monaco.languages.CompletionItemKind.Method,
          insertText: api.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: api.signature,
          documentation: { value: api.documentation },
          sortText: `1-${api.label}`,
        });
    return { suggestions, incomplete: !current };
  }
  async hover(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.Hover | undefined> {
    const current = await this.ready(model, token);
    if (!current) return;
    const { symbol, occurrence } = this.at(current, position);
    if (!symbol || !occurrence) return;
    return {
      range: editorRange(occurrence.range, current.snapshot.analysis.index.sources[current.file]!),
      contents: [
        { value: `\`\`\`basic-plus\n${symbolSignature(symbol)}\n\`\`\`` },
        ...(symbol.documentation ? [{ value: symbol.documentation }] : []),
      ],
    };
  }
  async signature(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.SignatureHelpResult | undefined> {
    const version = model.getVersionId();
    const call = editingContext(
      model.getLineContent(position.lineNumber).slice(0, position.column - 1),
    ).call;
    if (!call) return;
    const current = await this.ready(model, token);
    if (token.isCancellationRequested || model.isDisposed() || version !== model.getVersionId())
      return;
    const symbol =
      current &&
      visibleSymbols(
        current.snapshot.analysis.index,
        current.file,
        position.lineNumber,
        this.at(current, position).column,
      ).find(
        (s) => s.parameters && s.aliases.some((a) => a.toLowerCase() === call.name.toLowerCase()),
      );
    const api = BASIC_PLUS_API_COMPLETIONS.find(
      (a) => a.label.toLowerCase() === call.name.toLowerCase(),
    );
    if (!symbol && !api) return;
    const label = api?.signature ?? symbolSignature(symbol!, call.name);
    const parameterTexts = api
      ? label
          .slice(label.indexOf("(") + 1, label.lastIndexOf(")"))
          .split(", ")
          .filter(Boolean)
      : symbol!.parameters!.map((p) => `${p.direction} ${p.type} ${p.name}`);
    let start = label.indexOf("(") + 1;
    const parameters = parameterTexts.map((text) => {
      const range: [number, number] = [start, start + text.length];
      start += text.length + 2;
      return { label: range };
    });
    return {
      value: {
        signatures: [{ label, parameters, ...(api ? { documentation: api.documentation } : {}) }],
        activeSignature: 0,
        activeParameter: Math.min(call.argument, Math.max(0, parameters.length - 1)),
      },
      dispose() {},
    };
  }
  async definition(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.Location[]> {
    const current = await this.ready(model, token);
    if (!current) return [];
    const symbol = this.at(current, position).symbol;
    if (!symbol?.declaration) return [];
    const { file, range } = symbol.declaration;
    const source = current.snapshot.analysis.index.sources[file]!;
    return [{ uri: this.host.ensureModel(file, source).uri, range: editorRange(range, source) }];
  }
  async references(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    includeDeclaration: boolean,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.Location[]> {
    const current = await this.ready(model, token);
    if (!current) return [];
    const symbol = this.at(current, position).symbol;
    if (!symbol) return [];
    return symbolReferences(current.snapshot.analysis.index, symbol, includeDeclaration).map(
      ({ file, range }) => {
        const source = current.snapshot.analysis.index.sources[file]!;
        return { uri: this.host.ensureModel(file, source).uri, range: editorRange(range, source) };
      },
    );
  }
  async renameLocation(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.RenameLocation & monaco.languages.Rejection> {
    const current = await this.ready(model, token);
    const found = current && this.at(current, position);
    if (!current || !found?.symbol?.declaration || !found.occurrence || !this.host.canEdit())
      return {
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        ),
        text: "",
        rejectReason: "A current, editable user-defined symbol is required.",
      };
    const range = editorRange(
      found.occurrence.range,
      current.snapshot.analysis.index.sources[current.file]!,
    );
    return { range, text: model.getValueInRange(range) };
  }
  async rename(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    newName: string,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.WorkspaceEdit & monaco.languages.Rejection> {
    const current = await this.ready(model, token);
    if (!current || !this.host.canEdit())
      return {
        edits: [],
        rejectReason: "The document changed or is read-only. Try again after analysis completes.",
      };
    const result = prepareSymbolRename(
      current.snapshot.analysis,
      current.file,
      position.lineNumber,
      this.at(current, position).column,
      newName,
    );
    if (result.rejectReason) return { edits: [], rejectReason: result.rejectReason };
    const edits = {
      edits: result.edits!.map((edit) => {
        const source = current.snapshot.analysis.index.sources[edit.file]!;
        const target = this.host.ensureModel(edit.file, source);
        return {
          resource: target.uri,
          versionId: target.getVersionId(),
          textEdit: { range: editorRange(edit.range, source), text: edit.text },
        };
      }),
    };
    rememberRename(edits, current.snapshot);
    return edits;
  }
  dispose(): void {
    this.disposed = true;
    this.update(undefined);
    for (const registration of this.registrations) registration.dispose();
    this.registrations.length = 0;
  }
}
