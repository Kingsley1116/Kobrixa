import type { LanguageStatus } from "../../shared/language-services.js";
import type {
  StaticLanguageRegistrar,
  StaticModelContext,
  StaticModelRouteHooks,
} from "./static-language-registration.js";

import type { editor } from "monaco-editor";
import type { EditorLocation } from "../../shared/api.js";

/** Models outlive the visible editor, preserving undo across project switches. */
export class EditorModels {
  private registrar: StaticLanguageRegistrar | undefined;
  private workspaceId: string | undefined;
  private status: LanguageStatus | undefined;
  private readonly languageTracks = new Map<editor.ITextModel, { dispose(): void }>();
  private readonly languageHooks = new Map<editor.ITextModel, StaticModelRouteHooks>();
  getLanguageStatus(): LanguageStatus | undefined {
    return this.status;
  }
  configureLanguages(
    registrar: StaticLanguageRegistrar,
    workspaceId: string | undefined,
    status: LanguageStatus | undefined,
  ): void {
    this.registrar = registrar;
    this.workspaceId = workspaceId;
    this.status = status;
    registrar.refreshModels();
  }
  languageContext(model: editor.ITextModel): StaticModelContext {
    const file = [...this.models].find(([, value]) => value === model)?.[0] ?? model.uri.path;
    const binding =
      this.status?.availability.kind === "available" ? this.status.availability.binding : undefined;
    return {
      file,
      ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
      ...(binding ? { binding } : {}),
    };
  }
  trackLanguage(model: editor.ITextModel, hooks: StaticModelRouteHooks): void {
    this.languageHooks.set(model, hooks);
    if (!this.languageTracks.has(model) && this.registrar) {
      this.languageTracks.set(model, { dispose() {} });
      try {
        const handle = this.registrar.trackModel(model, () => this.languageContext(model), {
          beforeChange: (previous, next) =>
            this.languageHooks.get(model)?.beforeChange(previous, next),
          afterChange: (route) => this.languageHooks.get(model)?.afterChange(route),
        });
        this.languageTracks.set(model, handle);
      } catch (error) {
        this.languageTracks.delete(model);
        throw error;
      }
    }
  }
  releaseLanguageHooks(): void {
    this.languageHooks.clear();
  }
  forgetLanguage(model: editor.ITextModel): void {
    this.languageHooks.delete(model);
    this.languageTracks.get(model)?.dispose();
    this.languageTracks.delete(model);
  }

  readonly models = new Map<string, editor.ITextModel>();
  readonly views = new Map<string, editor.ICodeEditorViewState>();
  readonly locations: Record<string, EditorLocation>;
  constructor(locations: Record<string, EditorLocation> = {}) {
    this.locations = { ...locations };
  }
  capture(file: string, instance: editor.IStandaloneCodeEditor): void {
    const view = instance.saveViewState();
    if (view) this.views.set(file, view);
    const selection = instance.getSelection();
    if (selection)
      this.locations[file] = {
        line: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn,
        endLine: selection.positionLineNumber,
        endColumn: selection.positionColumn,
        scrollTop: instance.getScrollTop(),
        scrollLeft: instance.getScrollLeft(),
      };
  }
  format(file: string, before: string, after: string): void {
    const model = this.models.get(file);
    if (
      !model ||
      model.isDisposed() ||
      model.getValue(undefined, true) !== before ||
      before === after
    )
      return;
    model.pushStackElement();
    model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: after }], () => null);
    model.pushStackElement();
  }
  remap(moved: Readonly<Record<string, string>>): void {
    for (const [source, target] of Object.entries(moved)) {
      const location = this.locations[source];
      if (location) {
        this.locations[target] = location;
        delete this.locations[source];
      }
    }
  }
  dispose(): void {
    for (const model of this.models.values()) {
      this.forgetLanguage(model);
      model.dispose();
    }

    this.models.clear();
    this.views.clear();
  }
}
