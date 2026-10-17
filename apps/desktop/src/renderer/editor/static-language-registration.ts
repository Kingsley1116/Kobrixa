import type { editor, languages, IDisposable } from "monaco-editor";
import type { LanguageBinding } from "../../shared/language-services.js";
import type { PluginsApi } from "../../shared/plugins.js";
import type { StaticLanguageOwner } from "../../shared/static-languages.js";
import type { LexicalLanguageRoute } from "./static-language-routing.js";
import type { StaticLanguageStore, StaticLanguageStoreSnapshot } from "./static-language-store.js";

export interface MonacoStaticLanguageApi {
  languages: {
    register(language: { id: string }): void;
    setMonarchTokensProvider(id: string, tokenizer: languages.IMonarchLanguage): IDisposable;
    setLanguageConfiguration(
      id: string,
      configuration: languages.LanguageConfiguration,
    ): IDisposable;
  };
  editor: {
    getModels(): editor.ITextModel[];
    onDidCreateModel(listener: (model: editor.ITextModel) => void): IDisposable;
    onWillDisposeModel(listener: (model: editor.ITextModel) => void): IDisposable;
    setModelLanguage(model: editor.ITextModel, languageId: string): void;
  };
}
export interface StaticModelContext {
  file: string;
  workspaceId?: string;
  binding?: LanguageBinding;
}
export interface StaticModelRouteHooks {
  /** Detach dynamic providers and clear semantic coloring before provider disposal. */
  beforeChange(previous: LexicalLanguageRoute | undefined, next: LexicalLanguageRoute): void;
  afterChange(route: LexicalLanguageRoute): void;
}
export interface StaticLanguageRegistrar {
  /** Consumes owner revocations immediately, even if catalog.revision is still older. */
  reconcile(snapshot: StaticLanguageStoreSnapshot): void;
  /** Idempotent tracking; disposal releases context/hooks, never destroys the model. */
  trackModel(
    model: editor.ITextModel,
    context: () => StaticModelContext,
    hooks?: StaticModelRouteHooks,
  ): IDisposable;
  refreshModels(): void;
  resolve(context: StaticModelContext): LexicalLanguageRoute;
  getRoute(model: editor.ITextModel): LexicalLanguageRoute | undefined;
  getActiveOwners(): readonly StaticLanguageOwner[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export interface CreateStaticLanguageRegistrarInput {
  monaco: MonacoStaticLanguageApi;
  store: StaticLanguageStore;
  api: Pick<PluginsApi, "reportLanguageRegistrationFailure">;
  coreExtensionRoutes: Readonly<Record<string, string>>;
}
/** One per window. T0 installs no providers and does not touch models. */
export function createStaticLanguageRegistrar(
  input: CreateStaticLanguageRegistrarInput,
): StaticLanguageRegistrar {
  const emptyRoute = (): LexicalLanguageRoute => ({
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    kind: "plaintext",
    catalogRevision: input.store.getSnapshot().targetRevision,
  });
  return {
    reconcile() {},
    trackModel: () => ({ dispose() {} }),
    refreshModels() {},
    resolve: emptyRoute,
    getRoute: () => undefined,
    getActiveOwners: () => [],
    subscribe: () => () => {},
    dispose() {},
  };
}
