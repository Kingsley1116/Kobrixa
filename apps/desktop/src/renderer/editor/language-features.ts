import * as monaco from "monaco-editor";
import type { LanguageCapability } from "@kobrixa/plugin-protocol";
import { supportsFile, type LanguageBinding } from "../../shared/language-services.js";
import type { LanguageSymbol } from "../../shared/language-types.js";
import type {
  LanguageFeatureQuery,
  LanguageFeatureReply,
  LanguageFeatureResult,
} from "../../shared/language-query.js";
import type { LanguageCompanion } from "./language-companion.js";
import { rememberQuickFix, rememberRename } from "./workspace-edits.js";
import { sameDiagnostic, type QuickFixReply } from "../../shared/quick-fixes.js";
import type { Diagnostic } from "../../shared/api.js";
import type { DiagnosticLocale } from "@kobrixa/compiler/diagnostic-help";
import { quickFixTitle } from "./diagnostic-presentation.js";
import type { OutlineItem } from "./outline.js";
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
  binding(): LanguageBinding | undefined;
  companion(): LanguageCompanion | undefined;
  query(
    snapshot: EditorAnalysis,
    query: LanguageFeatureQuery,
    signal: AbortSignal,
  ): Promise<LanguageFeatureReply>;
  locale?(): DiagnosticLocale;
  quickFixes?(
    snapshot: EditorAnalysis,
    diagnostic: Diagnostic,
    signal: AbortSignal,
  ): Promise<QuickFixReply>;
  fileFor(model: monaco.editor.ITextModel): string | undefined;
  ensureModel(file: string, content: string): monaco.editor.ITextModel;
  canEdit(): boolean;
  isCurrent(model: monaco.editor.ITextModel, file: string, snapshot: EditorAnalysis): boolean;
  completionSymbols?(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): LanguageSymbol[] | undefined;
  refreshCompletions?(model: monaco.editor.ITextModel, position: monaco.Position): void;
}

/** Monaco adapter only; parsing and symbol binding stay in the background worker. */
export class LanguageFeatures implements monaco.IDisposable {
  private snapshot: EditorAnalysis | undefined;
  private readonly changed = new Set<() => void>();
  private readonly registrations: monaco.IDisposable[] = [];
  private disposed = false;
  private readonly pendingFixes = new Map<AbortController, monaco.editor.ITextModel>();
  private pendingCompletion:
    { model: monaco.editor.ITextModel; version: number; position: monaco.Position } | undefined;
  constructor(private readonly host: FeatureHost) {}
  update(snapshot: EditorAnalysis | undefined): void {
    if (this.snapshot !== snapshot)
      for (const controller of this.pendingFixes.keys()) controller.abort();
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
    const binding = this.host.binding();
    if (
      this.disposed ||
      !file ||
      !snapshot ||
      !binding ||
      snapshot.epoch !== binding.epoch ||
      !supportsFile(binding, file) ||
      !this.host.isCurrent(model, file, snapshot)
    )
      return;
    return { snapshot, file };
  }
  private async ready(model: monaco.editor.ITextModel, token: monaco.CancellationToken) {
    if (!this.routed(model) || token.isCancellationRequested) return;
    const version = model.getVersionId();
    const file = this.host.fileFor(model);
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
          !this.routed(model) ||
          this.host.fileFor(model) !== file ||
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
      this.routed(model) &&
      this.host.fileFor(model) === file &&
      version === model.getVersionId()
      ? this.current(model)
      : undefined;
  }
  private routed(model: monaco.editor.ITextModel, capability?: LanguageCapability): boolean {
    const binding = this.host.binding(),
      file = this.host.fileFor(model);
    return (
      !this.disposed &&
      !model.isDisposed() &&
      !!binding &&
      !!file &&
      supportsFile(binding, file) &&
      (!capability || binding.capabilities.includes(capability))
    );
  }
  unbind(model: monaco.editor.ITextModel): void {
    for (const [controller, target] of this.pendingFixes) if (target === model) controller.abort();
    if (this.pendingCompletion?.model === model) this.pendingCompletion = undefined;
    for (const listener of this.changed) listener();
  }
  private async query(
    model: monaco.editor.ITextModel,
    query: LanguageFeatureQuery,
    token: monaco.CancellationToken,
  ): Promise<
    | {
        current: NonNullable<ReturnType<LanguageFeatures["current"]>>;
        result: LanguageFeatureResult;
      }
    | undefined
  > {
    const capability = query.kind === "renameLocation" ? "rename" : query.kind;
    if (!this.routed(model, capability)) return;
    const current = await this.ready(model, token);
    if (
      !current ||
      current.file !== query.file ||
      this.current(model)?.snapshot !== current.snapshot
    )
      return;
    const version = model.getVersionId();
    const controller = new AbortController();
    this.pendingFixes.set(controller, model);
    const cancel = token.onCancellationRequested(() => controller.abort());
    // The accepted snapshot may have arrived while ready() was waiting (including a BOM).
    const source = current.snapshot.analysis.index.sources[current.file] ?? "";
    const request =
      "line" in query
        ? {
            ...query,
            column: query.column + (query.line === 1 && source.startsWith("\uFEFF") ? 1 : 0),
          }
        : query;
    try {
      const reply = await this.host.query(current.snapshot, request, controller.signal);
      if (
        reply.kind !== "result" ||
        reply.epoch !== current.snapshot.epoch ||
        controller.signal.aborted ||
        token.isCancellationRequested ||
        !this.routed(model, capability) ||
        model.getVersionId() !== version ||
        this.current(model)?.file !== current.file ||
        this.current(model)?.snapshot !== current.snapshot
      )
        return;
      return { current, result: reply.result };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return;
    } finally {
      cancel.dispose();
      this.pendingFixes.delete(controller);
    }
  }
  private positionQuery(model: monaco.editor.ITextModel, position: monaco.Position) {
    return {
      file: this.host.fileFor(model) ?? "",
      line: position.lineNumber,
      column: position.column,
    };
  }
  private canAskFix(
    current: NonNullable<ReturnType<LanguageFeatures["current"]>>,
    diagnostic: Diagnostic,
  ): boolean {
    const binding = this.host.binding();
    return (
      !!binding?.capabilities.includes("quickFixes") &&
      diagnostic.source === binding.pluginId &&
      current.snapshot.epoch === binding.epoch
    );
  }
  register(): void {
    const binding = this.host.binding(),
      companion = this.host.companion();
    if (!binding || !companion) return;
    const selector = { language: companion.monacoLanguage, scheme: "kobrixa" };
    const add = (capability: LanguageCapability, register: () => monaco.IDisposable) => {
      if (binding.capabilities.includes(capability)) this.registrations.push(register());
    };
    add("completion", () =>
      monaco.languages.registerCompletionItemProvider(selector, {
        triggerCharacters: companion.triggerCharacters,
        provideCompletionItems: (m, p, _c, t) => this.completions(m, p, t),
      }),
    );
    add("hover", () =>
      monaco.languages.registerHoverProvider(selector, {
        provideHover: (m, p, t) => this.hover(m, p, t),
      }),
    );
    add("signatureHelp", () =>
      monaco.languages.registerSignatureHelpProvider(selector, {
        signatureHelpTriggerCharacters: companion.signatureTriggers,
        signatureHelpRetriggerCharacters: companion.signatureRetriggers,
        provideSignatureHelp: (m, p, t) => this.signature(m, p, t),
      }),
    );
    add("documentSymbols", () =>
      monaco.languages.registerDocumentSymbolProvider(selector, {
        displayName: binding.language,
        provideDocumentSymbols: (m, t) => this.documentSymbols(m, t),
      }),
    );
    add("definition", () =>
      monaco.languages.registerDefinitionProvider(selector, {
        provideDefinition: (m, p, t) => this.definition(m, p, t),
      }),
    );
    add("references", () =>
      monaco.languages.registerReferenceProvider(selector, {
        provideReferences: (m, p, c, t) => this.references(m, p, c.includeDeclaration, t),
      }),
    );
    add("rename", () =>
      monaco.languages.registerRenameProvider(selector, {
        resolveRenameLocation: (m, p, t) => this.renameLocation(m, p, t),
        provideRenameEdits: (m, p, n, t) => this.rename(m, p, n, t),
      }),
    );
    add("quickFixes", () =>
      monaco.languages.registerCodeActionProvider(
        selector,
        {
          provideCodeActions: async (model, range, context, token) => {
            if (context.only && !"quickfix".startsWith(context.only))
              return { actions: [], dispose() {} };
            const current = await this.ready(model, token);
            if (!current || token.isCancellationRequested) return { actions: [], dispose() {} };
            const actions: monaco.languages.CodeAction[] = [];
            const seen = new Set<string>();
            for (const diagnostic of current.snapshot.analysis.diagnostics) {
              if (diagnostic.file !== current.file || !this.canAskFix(current, diagnostic))
                continue;
              const source = current.snapshot.analysis.index.sources[current.file] ?? "";
              const marker = model.validateRange(editorRange(diagnostic.range, source));
              if (
                marker.endLineNumber < range.startLineNumber ||
                marker.startLineNumber > range.endLineNumber ||
                (marker.endLineNumber === range.startLineNumber &&
                  marker.endColumn < range.startColumn) ||
                (marker.startLineNumber === range.endLineNumber &&
                  marker.startColumn > range.endColumn)
              )
                continue;
              for (const action of await this.quickFixes(model, diagnostic, token)) {
                const key = JSON.stringify(action.edit?.edits);
                if (!seen.has(key)) {
                  seen.add(key);
                  actions.push(action);
                }
              }
            }
            return { actions, dispose() {} };
          },
        },
        { providedCodeActionKinds: ["quickfix"] },
      ),
    );
    add("documentFormatting", () =>
      monaco.languages.registerDocumentFormattingEditProvider(selector, {
        provideDocumentFormattingEdits: (model, options, token) =>
          this.host.binding()?.epoch === binding.epoch &&
          this.routed(model, "documentFormatting") &&
          !token.isCancellationRequested
            ? [
                {
                  range: model.getFullModelRange(),
                  text: companion.formatSource(model.getValue(), options.tabSize === 4 ? 4 : 2),
                },
              ]
            : [],
      }),
    );
    add("rangeFormatting", () =>
      monaco.languages.registerDocumentRangeFormattingEditProvider(selector, {
        provideDocumentRangeFormattingEdits: (model, range, options, token) =>
          this.host.binding()?.epoch === binding.epoch &&
          this.routed(model, "rangeFormatting") &&
          !token.isCancellationRequested
            ? companion.rangeFormatting(model, range, options, token)
            : [],
      }),
    );
  }
  async documentSymbols(
    model: monaco.editor.ITextModel,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.DocumentSymbol[]> {
    const response = await this.query(
      model,
      { kind: "documentSymbols", file: this.host.fileFor(model) ?? "" },
      token,
    );
    if (response?.result.kind !== "documentSymbols") return [];
    const source = response.current.snapshot.analysis.index.sources[response.current.file] ?? "";
    const kinds = {
      function: monaco.languages.SymbolKind.Function,
      method: monaco.languages.SymbolKind.Method,
      variable: monaco.languages.SymbolKind.Variable,
      parameter: monaco.languages.SymbolKind.Variable,
      label: monaco.languages.SymbolKind.Key,
      namespace: monaco.languages.SymbolKind.Namespace,
    };
    const convert = (item: OutlineItem): monaco.languages.DocumentSymbol => ({
      name: item.name,
      detail: item.detail,
      kind: kinds[item.kind],
      tags: [],
      range: model.validateRange(editorRange(item.range, source)),
      selectionRange: model.validateRange(editorRange(item.selectionRange, source)),
      children: item.children.map(convert),
    });
    return response.result.symbols.map(convert);
  }
  async quickFixes(
    model: monaco.editor.ITextModel,
    diagnostic: Diagnostic,
    token?: monaco.CancellationToken,
    signal?: AbortSignal,
  ): Promise<monaco.languages.CodeAction[]> {
    const current = this.current(model);
    if (
      !current ||
      !this.host.quickFixes ||
      !this.host.canEdit() ||
      token?.isCancellationRequested ||
      signal?.aborted ||
      diagnostic.file !== current.file ||
      !this.canAskFix(current, diagnostic) ||
      !current.snapshot.analysis.diagnostics.some(
        (d) => d.file === diagnostic.file && sameDiagnostic(d, diagnostic),
      )
    )
      return [];
    const version = model.getVersionId();
    const controller = new AbortController();
    this.pendingFixes.set(controller, model);
    const abort = () => controller.abort();
    const cancellation = token?.onCancellationRequested(abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (token?.isCancellationRequested || signal?.aborted) abort();
    let result: QuickFixReply;
    try {
      result = await this.host.quickFixes(current.snapshot, diagnostic, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return [];
      throw error;
    } finally {
      cancellation?.dispose();
      signal?.removeEventListener("abort", abort);
      this.pendingFixes.delete(controller);
    }
    if (
      result.kind !== "result" ||
      result.epoch !== current.snapshot.epoch ||
      controller.signal.aborted ||
      token?.isCancellationRequested ||
      this.disposed ||
      model.isDisposed() ||
      version !== model.getVersionId() ||
      !this.host.canEdit() ||
      this.current(model)?.snapshot !== current.snapshot
    )
      return [];
    const source = current.snapshot.analysis.index.sources[current.file]!;
    return result.fixes.map((fix) => {
      const title = quickFixTitle(fix.title, this.host.locale?.() ?? "en");
      const edit: monaco.languages.WorkspaceEdit = {
        edits: fix.edits.map((item) => ({
          resource: model.uri,
          versionId: version,
          textEdit: { range: editorRange(item.range, source), text: item.newText },
        })),
      };
      rememberQuickFix(edit, current.snapshot, current.file, title);
      return { title, kind: "quickfix", edit };
    });
  }
  async completions(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.CompletionList> {
    const companion = this.host.companion();
    if (!companion || !this.routed(model, "completion") || token.isCancellationRequested)
      return { suggestions: [] };
    const current = this.current(model);
    if (!current) this.pendingCompletion = { model, version: model.getVersionId(), position };
    const candidates = this.host.completionSymbols?.(model, position) ?? [];
    return { ...companion.completions(model, position, candidates, token), incomplete: !current };
  }
  async hover(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.Hover | undefined> {
    const response = await this.query(
      model,
      { kind: "hover", ...this.positionQuery(model, position) },
      token,
    );
    if (response?.result.kind !== "hover" || !response.result.value) return;
    return {
      range: editorRange(
        response.result.value.range,
        response.current.snapshot.analysis.index.sources[response.current.file] ?? "",
      ),
      contents: response.result.value.contents.map((value) => ({ value })),
    };
  }
  async signature(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.SignatureHelpResult | undefined> {
    if (!this.routed(model, "signatureHelp") || token.isCancellationRequested) return;
    const immediate = !this.current(model)
      ? this.host.companion()?.signatureHelp?.(model, position, token)
      : undefined;
    const response = immediate
      ? undefined
      : await this.query(
          model,
          { kind: "signatureHelp", ...this.positionQuery(model, position) },
          token,
        );
    const value =
      immediate ?? (response?.result.kind === "signatureHelp" ? response.result.value : undefined);
    if (!value) return;
    return {
      value: {
        signatures: [
          {
            label: value.label,
            parameters: value.parameters.map((label) => ({ label })),
            ...(value.documentation === undefined ? {} : { documentation: value.documentation }),
          },
        ],
        activeSignature: 0,
        activeParameter: value.activeParameter,
      },
      dispose() {},
    };
  }
  async definition(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.Location[]> {
    const response = await this.query(
      model,
      { kind: "definition", ...this.positionQuery(model, position) },
      token,
    );
    if (response?.result.kind !== "definition") return [];
    return response.result.locations.map(({ file, range }) => {
      const source = response.current.snapshot.analysis.index.sources[file] ?? "";
      return { uri: this.host.ensureModel(file, source).uri, range: editorRange(range, source) };
    });
  }
  async references(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    includeDeclaration: boolean,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.Location[]> {
    const response = await this.query(
      model,
      { kind: "references", ...this.positionQuery(model, position), includeDeclaration },
      token,
    );
    if (response?.result.kind !== "references") return [];
    return response.result.locations.map(({ file, range }) => {
      const source = response.current.snapshot.analysis.index.sources[file] ?? "";
      return { uri: this.host.ensureModel(file, source).uri, range: editorRange(range, source) };
    });
  }
  async renameLocation(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.RenameLocation & monaco.languages.Rejection> {
    const response = this.host.canEdit()
      ? await this.query(
          model,
          { kind: "renameLocation", ...this.positionQuery(model, position) },
          token,
        )
      : undefined;
    if (
      response?.result.kind !== "renameLocation" ||
      !response.result.range ||
      response.result.rejectReason ||
      !this.host.canEdit()
    )
      return {
        range: new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        ),
        text: "",
        rejectReason:
          (response?.result.kind === "renameLocation" && response.result.rejectReason) ||
          "A current, editable user-defined symbol is required.",
      };
    return {
      range: editorRange(
        response.result.range,
        response.current.snapshot.analysis.index.sources[response.current.file] ?? "",
      ),
      text: response.result.text,
    };
  }
  async rename(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    newName: string,
    token: monaco.CancellationToken,
  ): Promise<monaco.languages.WorkspaceEdit & monaco.languages.Rejection> {
    const response = this.host.canEdit()
      ? await this.query(
          model,
          { kind: "rename", ...this.positionQuery(model, position), newName },
          token,
        )
      : undefined;
    if (response?.result.kind !== "rename" || !this.host.canEdit())
      return {
        edits: [],
        rejectReason: "The document changed or is read-only. Try again after analysis completes.",
      };
    if (response.result.rejectReason)
      return { edits: [], rejectReason: response.result.rejectReason };
    const edits = {
      edits: response.result.edits.map(({ file, range, text }) => {
        const source = response.current.snapshot.analysis.index.sources[file] ?? "";
        const target = this.host.ensureModel(file, source);
        return {
          resource: target.uri,
          versionId: target.getVersionId(),
          textEdit: { range: editorRange(range, source), text },
        };
      }),
    };
    rememberRename(edits, response.current.snapshot);
    return edits;
  }
  dispose(): void {
    this.disposed = true;
    this.update(undefined);
    for (const registration of this.registrations) registration.dispose();
    this.registrations.length = 0;
  }
}
