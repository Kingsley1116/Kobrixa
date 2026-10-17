import { CORE_LANGUAGE_IDS } from "./core-language-routes.js";
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1,
} from "@kobrixa/plugin-protocol";
import type {
  StaticLanguageOwner,
  ValidatedStaticLanguage,
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
} from "../../shared/static-languages.js";
import { adaptStaticLanguage, StaticLanguageAdapterError } from "./static-language-adapter.js";
import { resolveLexicalLanguage, type LexicalLanguageRoute } from "./static-language-routing.js";

import type { editor, languages, IDisposable } from "monaco-editor";
import type { LanguageBinding } from "../../shared/language-services.js";
import type { PluginsApi } from "../../shared/plugins.js";
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
interface InstalledLanguage {
  language: ValidatedStaticLanguage;
  tokens: IDisposable;
  configuration: IDisposable;
}
interface TrackingLease {
  context: () => StaticModelContext;
  hooks: StaticModelRouteHooks | undefined;
  references: number;
}
interface TrackedModel {
  model: editor.ITextModel;
  leases: TrackingLease[];
  route: LexicalLanguageRoute | undefined;
  hooks: StaticModelRouteHooks | undefined;
  contextKey: string;
}
interface SessionHistory {
  ids: Set<string>;
  quarantined: Set<string>;
}
// Monaco's language registry outlives a registrar instance, including effect replay.
const sessions = new WeakMap<MonacoStaticLanguageApi["languages"], SessionHistory>();
const identity = (value: {
  pluginId: string;
  sourceKey: string;
  generation: number;
  languageId: string;
}): string => JSON.stringify([value.pluginId, value.sourceKey, value.generation, value.languageId]);
const languageIdentity = (value: ValidatedStaticLanguage): string =>
  identity({
    pluginId: value.pluginId,
    sourceKey: value.sourceKey,
    generation: value.generation,
    languageId: value.id,
  });
function release(value: IDisposable | undefined): void {
  try {
    value?.dispose();
  } catch {
    /* Continue disposing the other half and all models. */
  }
}
function sameRoute(a: LexicalLanguageRoute | undefined, b: LexicalLanguageRoute): boolean {
  return (
    a?.monacoLanguage === b.monacoLanguage &&
    a.kind === b.kind &&
    a.displayName === b.displayName &&
    a.catalogRevision === b.catalogRevision &&
    (a.staticOwner ? identity(a.staticOwner) : "") ===
      (b.staticOwner ? identity(b.staticOwner) : "")
  );
}

export function createStaticLanguageRegistrar(
  input: CreateStaticLanguageRegistrarInput,
): StaticLanguageRegistrar {
  const { monaco, store, api, coreExtensionRoutes } = input;
  let session = sessions.get(monaco.languages);
  if (!session) {
    session = { ids: new Set(), quarantined: new Set() };
    sessions.set(monaco.languages, session);
  }
  const history = session;
  const active = new Map<string, InstalledLanguage>();
  const models = new Map<editor.ITextModel, TrackedModel>();
  const listeners = new Set<() => void>();
  const coreIds = CORE_LANGUAGE_IDS;
  // Metadata-discovered conflicts cannot be cleared by another partial snapshot.
  // Only a complete catalog for the current target resets these provisional decisions.
  const pendingAmbiguities = new Set<string>();
  let current = store.getSnapshot();
  let highestRevision = -1;
  let disposed = false;
  const getActiveOwners = (): StaticLanguageOwner[] =>
    current.owners.filter((owner) => {
      const installed = active.get(owner.languageId);
      return installed !== undefined && languageIdentity(installed.language) === identity(owner);
    });
  const routingCatalog = (): StaticLanguagesCatalog => {
    // Owner metadata can revoke a route or reveal ambiguity, but cannot prove global
    // uniqueness: budget-losing/marker-filtered claimants may not be delivered.
    // Pending/failed fetches retain only previously authorized concrete routes to the
    // same sole announced owner. Known nulls and previously absent mappings stay plain.
    const routes: Record<string, string | null> = Object.create(null);
    for (const [extension, id] of Object.entries(current.catalog.extensionRoutes)) {
      if (id === null || pendingAmbiguities.has(extension)) {
        routes[extension] = null;
        continue;
      }
      // Count all announced owners here, including those not yet installed.
      const announced = current.owners.filter((owner) => owner.extensions.includes(extension));
      const previous = current.catalog.languages.find((language) => language.id === id);
      routes[extension] =
        announced.length === 1 &&
        previous !== undefined &&
        previous.extensions.includes(extension) &&
        languageIdentity(previous) === identity(announced[0]!)
          ? id
          : null;
    }
    const owners = getActiveOwners();
    const languages = owners.map((owner) => ({
      ...active.get(owner.languageId)!.language,
      extensions: [...owner.extensions],
    }));
    return {
      formatVersion: 1,
      limitsVersion: 1,
      revision: current.targetRevision,
      languages,
      extensionRoutes:
        current.phase === "ready" && current.catalog.revision === current.targetRevision
          ? current.catalog.extensionRoutes
          : routes,
      conflicts: current.catalog.conflicts,
    };
  };
  const resolve = (context: StaticModelContext): LexicalLanguageRoute =>
    resolveLexicalLanguage({
      file: context.file,
      ...(context.binding ? { binding: context.binding } : {}),
      catalog: routingCatalog(),
      activeOwners: getActiveOwners(),
      coreExtensionRoutes,
    });
  const apply = (tracked: TrackedModel): void => {
    if (tracked.model.isDisposed()) return;
    const lease = tracked.leases.at(-1);
    const context = lease?.context() ?? {
      file: tracked.model.uri.fsPath || tracked.model.uri.path,
    };
    const next = resolve(context);
    const key = JSON.stringify([
      context.file,
      context.workspaceId,
      context.binding?.pluginId,
      context.binding?.sourceKey,
      context.binding?.language,
      context.binding?.epoch,
    ]);
    const hooks = lease?.hooks;
    if (
      sameRoute(tracked.route, next) &&
      tracked.contextKey === key &&
      tracked.hooks === hooks &&
      tracked.model.getLanguageId() === next.monacoLanguage
    )
      return;
    // The old hook owns its dynamic attachments, even when the new lease has none.
    try {
      tracked.hooks?.beforeChange(tracked.route, next);
      if (!tracked.hooks && hooks) hooks.beforeChange(tracked.route, next);
    } finally {
      if (tracked.model.getLanguageId() !== next.monacoLanguage)
        monaco.editor.setModelLanguage(tracked.model, next.monacoLanguage);
      tracked.route = next;
      tracked.contextKey = key;
      tracked.hooks = hooks;
      try {
        hooks?.afterChange(next);
      } finally {
        for (const listener of listeners) listener();
      }
    }
  };
  const refreshModels = (): void => {
    for (const tracked of models.values()) {
      try {
        apply(tracked);
      } catch {
        // A broken lease, hook or model must not retain revoked providers or
        // prevent other models from reconciling. A later refresh can retry it.
      }
    }
  };
  const ensure = (model: editor.ITextModel): TrackedModel => {
    let tracked = models.get(model);
    if (!tracked) {
      tracked = { model, leases: [], route: undefined, hooks: undefined, contextKey: "" };
      models.set(model, tracked);
      apply(tracked);
    }
    return tracked;
  };
  const fail = (
    language: ValidatedStaticLanguage,
    reason: ReportLanguageRegistrationFailureInput["reason"],
    error?: unknown,
  ): void => {
    const key = languageIdentity(language);
    if (history.quarantined.has(key)) return;
    history.quarantined.add(key);
    // Error messages can contain authored patterns or physical paths, which the
    // IPC schema deliberately rejects. Only bounded, known error names cross it.
    const names = ["Error", "SyntaxError", "TypeError", "RangeError", "StaticLanguageAdapterError"];
    const name = error instanceof Error && names.includes(error.name) ? error.name : "Error";
    const detail = `Static language registration failed (${name}).`;
    // Reporting failure never makes the local failed contribution eligible again.
    try {
      void api
        .reportLanguageRegistrationFailure({
          sourceKey: language.sourceKey,
          generation: language.generation,
          languageId: language.id,
          revision: current.catalog.revision,
          reason,
          detail,
        })
        .catch(() => {});
    } catch {
      /* A synchronous bridge failure is also locally quarantined. */
    }
  };
  const install = (language: ValidatedStaticLanguage): void => {
    if (history.quarantined.has(languageIdentity(language))) return;
    if (
      current.catalog.formatVersion !== STATIC_LANGUAGE_FORMAT_VERSION ||
      current.catalog.limitsVersion !== STATIC_LANGUAGE_FORMAT_VERSION
    ) {
      fail(language, "dto-version", "Unsupported static language format or limits version");
      return;
    }
    if (coreIds.has(language.id)) {
      fail(language, "validation", "Language id is reserved by the host");
      return;
    }
    let definition: ReturnType<typeof adaptStaticLanguage>;
    try {
      definition = adaptStaticLanguage(language);
    } catch (error) {
      fail(
        language,
        error instanceof StaticLanguageAdapterError ? error.reason : "validation",
        error,
      );
      return;
    }
    if (
      !history.ids.has(language.id) &&
      history.ids.size >= STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds
    ) {
      fail(
        language,
        "session-language-ids",
        "Renderer language id limit reached; restart the window to load more languages",
      );
      return;
    }
    let tokens: IDisposable | undefined;
    let configuration: IDisposable | undefined;
    try {
      if (!history.ids.has(language.id)) {
        // Count calls, including a register() that throws after creating its shell.
        history.ids.add(language.id);
        monaco.languages.register({ id: language.id });
      }
      tokens = monaco.languages.setMonarchTokensProvider(language.id, definition.tokenizer);
      configuration = monaco.languages.setLanguageConfiguration(
        language.id,
        definition.configuration,
      );
      active.set(language.id, { language, tokens, configuration });
    } catch (error) {
      release(tokens);
      release(configuration);
      fail(language, "monaco", error);
    }
  };
  const reconcile = (snapshot: StaticLanguageStoreSnapshot): void => {
    if (disposed || snapshot.targetRevision < highestRevision) return;
    highestRevision = snapshot.targetRevision;
    current = snapshot;
    const complete =
      snapshot.phase === "ready" && snapshot.catalog.revision === snapshot.targetRevision;
    if (complete) pendingAmbiguities.clear();
    else {
      const seen = new Set<string>();
      for (const owner of snapshot.owners)
        for (const extension of owner.extensions) {
          if (seen.has(extension)) pendingAmbiguities.add(extension);
          seen.add(extension);
        }
    }
    const versionsMatch =
      snapshot.catalog.formatVersion === STATIC_LANGUAGE_FORMAT_VERSION &&
      snapshot.catalog.limitsVersion === STATIC_LANGUAGE_FORMAT_VERSION;
    const removed: InstalledLanguage[] = [];
    for (const [id, installed] of active) {
      const key = languageIdentity(installed.language);
      const owner = snapshot.owners.find((candidate) => identity(candidate) === key);
      const candidate = snapshot.catalog.languages.find((value) => languageIdentity(value) === key);
      if (
        !owner ||
        (complete &&
          (!versionsMatch ||
            !candidate ||
            candidate.resourceDigest !== installed.language.resourceDigest))
      ) {
        active.delete(id);
        removed.push(installed);
      } else if (complete && candidate) installed.language = candidate;
    }
    // Withdraw eligibility, detach/clear and reroute ALL models, then dispose providers.
    try {
      refreshModels();
    } finally {
      for (const installed of removed) {
        release(installed.tokens);
        release(installed.configuration);
      }
    }
    if (complete) {
      for (const language of snapshot.catalog.languages) {
        if (
          !active.has(language.id) &&
          snapshot.owners.some((owner) => identity(owner) === languageIdentity(language))
        )
          install(language);
      }
    }
    refreshModels();
    for (const listener of listeners) listener();
  };
  // Subscribe to model creation before enumerating, covering the creation/enumeration gap.
  const created = monaco.editor.onDidCreateModel((model) => {
    if (!disposed) ensure(model);
  });
  const removing = monaco.editor.onWillDisposeModel((model) => {
    const tracked = models.get(model);
    if (tracked) {
      try {
        tracked.hooks?.beforeChange(tracked.route, {
          monacoLanguage: "plaintext",
          displayName: "Plain Text",
          kind: "plaintext",
          catalogRevision: current.targetRevision,
        });
      } finally {
        models.delete(model);
        for (const listener of listeners) listener();
      }
    }
  });
  for (const model of monaco.editor.getModels()) if (!model.isDisposed()) ensure(model);
  const off = store.subscribe(() => reconcile(store.getSnapshot()));
  reconcile(store.getSnapshot());
  return {
    reconcile,
    trackModel(model, context, hooks) {
      if (disposed || model.isDisposed()) return { dispose() {} };
      const tracked = ensure(model);
      let lease = tracked.leases.find(
        (value) => value.context === context && value.hooks === hooks,
      );
      if (lease) lease.references++;
      else {
        lease = { context, hooks, references: 1 };
        tracked.leases.push(lease);
        apply(tracked);
      }
      const acquired = lease;
      let released = false;
      return {
        dispose() {
          if (released) return;
          released = true;
          if (--acquired.references > 0 || disposed || !models.has(model)) return;
          tracked.leases = tracked.leases.filter((value) => value !== acquired);
          apply(tracked);
        },
      };
    },
    refreshModels() {
      if (!disposed) refreshModels();
    },
    resolve,
    getRoute: (model) => models.get(model)?.route,
    getActiveOwners,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      off();
      release(created);
      release(removing);
      const installed = [...active.values()];
      active.clear();
      refreshModels();
      for (const value of installed) {
        release(value.tokens);
        release(value.configuration);
      }
      models.clear();
      listeners.clear();
      disposed = true;
    },
  };
}
