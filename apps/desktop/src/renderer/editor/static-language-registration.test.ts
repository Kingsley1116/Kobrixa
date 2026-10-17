import { readFileSync } from "node:fs";
import { bootstrapStaticLanguages } from "./static-language-bootstrap.js";
import { CORE_LANGUAGE_IDS } from "./core-language-routes.js";
import { beforeEach, expect, it, vi } from "vitest";
import type * as PluginProtocol from "@kobrixa/plugin-protocol";
import type { editor } from "monaco-editor";
import {
  validateStaticLanguageResources,
  type StaticLanguageTokenizerV1,
  type StaticLanguageConfigurationV1,
  type StaticLanguageValidationResult,
} from "@kobrixa/plugin-protocol";
import type { PluginEvent, PluginsView } from "../../shared/plugins.js";
import type { LanguageBinding } from "../../shared/language-services.js";
import type {
  StaticLanguageOwner,
  StaticLanguagesCatalog,
  ValidatedStaticLanguage,
  ReportLanguageRegistrationFailureInput,
} from "../../shared/static-languages.js";
import {
  createStaticLanguageStore,
  type StaticLanguageStore,
  type StaticLanguageStoreSnapshot,
} from "./static-language-store.js";
import {
  createStaticLanguageRegistrar,
  type MonacoStaticLanguageApi,
  type StaticModelContext,
} from "./static-language-registration.js";

vi.mock("@kobrixa/plugin-protocol", async (original) => ({
  ...(await original<typeof PluginProtocol>()),
  validateStaticLanguageResources: vi.fn(),
}));
vi.mock("monaco-editor", () => ({
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
}));
const validate = vi.mocked(validateStaticLanguageResources);
beforeEach(() => {
  validate.mockReset();
  validate.mockImplementation((input): StaticLanguageValidationResult => ({
    ok: true,
    tokenizer: input.tokenizer as StaticLanguageTokenizerV1,
    configuration: input.configuration as StaticLanguageConfigurationV1,
    resourceBytes: input.resourceBytes,
    expandedRules: 1,
    rules: 1,
    regexes: 1,
  }));
});
function language(id = "toy", generation = 1, extensions = ["toy"]): ValidatedStaticLanguage {
  const root = new URL(
    "../../../../../packages/plugin-protocol/test-fixtures/static-languages/minimal/",
    import.meta.url,
  );
  const tokenizer = readFileSync(new URL("tokenizer.json", root));
  const configuration = readFileSync(new URL("configuration.json", root));
  return {
    id,
    generation,
    extensions,
    pluginId: `acme.${id}`,
    sourceKey: `development:${id}`,
    aliases: ["Toy 😀"],
    resourceDigest: `${id}:${generation}`,
    tokenizer: JSON.parse(tokenizer.toString()),
    configuration: JSON.parse(configuration.toString()),
    resourceBytes: { tokenizer: tokenizer.byteLength, configuration: configuration.byteLength },
    expandedRules: 1,
  };
}
const owner = (value: ValidatedStaticLanguage): StaticLanguageOwner => ({
  pluginId: value.pluginId,
  sourceKey: value.sourceKey,
  generation: value.generation,
  languageId: value.id,
  extensions: value.extensions,
});
function catalog(revision: number, languages: ValidatedStaticLanguage[]): StaticLanguagesCatalog {
  const routes: Record<string, string | null> = Object.create(null);
  for (const item of languages)
    for (const extension of item.extensions)
      routes[extension] = Object.hasOwn(routes, extension) ? null : item.id;
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision,
    languages,
    extensionRoutes: routes,
    conflicts: [],
  };
}
// The same producer-shaped DTOs as the store tests, using real minimal resources.
// Hidden candidates are not installed and are not required in owner metadata.
function authoritativeCatalog(
  kind: "budget-loser" | "marker-filtered" | "quarantined-claimant",
  revision: number,
): StaticLanguagesCatalog {
  const languages = Array.from({ length: kind === "budget-loser" ? 128 : 2 }, (_, index) => ({
    ...language(`lang${index}`, 1, [index === 0 ? "shared" : `x${index}`]),
    pluginId: `test.i${String(index).padStart(3, "0")}`,
    sourceKey: `builtin:test.i${String(index).padStart(3, "0")}`,
  }));
  return {
    ...catalog(revision, languages),
    extensionRoutes: {
      ...Object.fromEntries(languages.slice(1).map((value) => [value.extensions[0]!, value.id])),
      shared: null,
    },
    conflicts:
      kind === "budget-loser"
        ? [
            {
              kind: "extension",
              key: "shared",
              sources: [
                { pluginId: "test.i000", sourceKey: "builtin:test.i000", languageId: "lang0" },
                { pluginId: "test.i128", sourceKey: "builtin:test.i128", languageId: "lang128" },
              ],
            },
          ]
        : [],
  };
}
const ready = (value: StaticLanguagesCatalog): StaticLanguageStoreSnapshot => ({
  phase: "ready",
  targetRevision: value.revision,
  owners: value.languages.map(owner),
  catalog: value,
});
const bindingFor = (value: ValidatedStaticLanguage): LanguageBinding => ({
  pluginId: value.pluginId,
  sourceKey: value.sourceKey,
  language: value.id,
  epoch: 11,
  extensions: value.extensions,
  capabilities: ["analysis", "semanticTokens"],
  frontend: {
    language: value.id,
    entryExtensions: [value.extensions[0]!],
    sourceExtensions: value.extensions,
    ir: { min: 1, max: 1 },
  },
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function state(value: StaticLanguagesCatalog): PluginsView {
  return {
    revision: value.revision,
    diagnosticHelpRevision: 0,
    staticLanguagesRevision: value.revision,
    staticLanguageOwners: value.languages.map(owner),
    safeMode: false,
    developmentMode: true,
    plugins: [],
    developer: { enabled: true, commandLine: false, linkedCount: 0 },
    origins: {},
    python: { pendingReload: [] },
    inflight: [],
  };
}
function harness(initial = ready(catalog(0, [])), externalStore?: StaticLanguageStore) {
  let snapshot = initial;
  const subscriptions = new Set<() => void>();
  const localStore: StaticLanguageStore = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      subscriptions.add(listener);
      return () => {
        subscriptions.delete(listener);
      };
    },
    ready: async () => {},
    refresh: async () => {},
    dispose() {},
  };
  const store = externalStore ?? localStore;
  const created = new Set<(model: editor.ITextModel) => void>();
  const removing = new Set<(model: editor.ITextModel) => void>();
  const models = new Set<editor.ITextModel>();
  const values = new Map<
    editor.ITextModel,
    { language: string; text: string; undo: string[]; disposed: boolean }
  >();
  const log: string[] = [];
  const tokenDisposals: ReturnType<typeof vi.fn>[] = [];
  const configurationDisposals: ReturnType<typeof vi.fn>[] = [];
  const register = vi.fn((_value: { id: string }): void => {});
  const tokens = vi.fn(() => {
    const dispose = vi.fn(() => {
      log.push("dispose:tokens");
    });
    tokenDisposals.push(dispose);
    return { dispose };
  });
  const configuration = vi.fn(() => {
    const dispose = vi.fn(() => {
      log.push("dispose:configuration");
    });
    configurationDisposals.push(dispose);
    return { dispose };
  });
  const setModelLanguage = vi.fn((model: editor.ITextModel, id: string) => {
    log.push(`language:${id}`);
    values.get(model)!.language = id;
  });
  const monaco: MonacoStaticLanguageApi = {
    languages: {
      register,
      setMonarchTokensProvider: tokens,
      setLanguageConfiguration: configuration,
    },
    editor: {
      getModels: () => [...models],
      setModelLanguage,
      onDidCreateModel(listener) {
        created.add(listener);
        return {
          dispose() {
            created.delete(listener);
          },
        };
      },
      onWillDisposeModel(listener) {
        removing.add(listener);
        return {
          dispose() {
            removing.delete(listener);
          },
        };
      },
    },
  };
  const report = vi.fn(async (_input: ReportLanguageRegistrationFailureInput) => ({
    accepted: true,
    revision: 99,
  }));
  const input = {
    monaco,
    store,
    api: { reportLanguageRegistrationFailure: report },
    coreExtensionRoutes: { json: "json" },
  };
  const registrar = createStaticLanguageRegistrar(input);
  return {
    registrar,
    input,
    register,
    tokens,
    configuration,
    report,
    log,
    tokenDisposals,
    configurationDisposals,
    values,
    setModelLanguage,
    created,
    removing,
    subscriptions,
    publish(next: StaticLanguageStoreSnapshot) {
      snapshot = next;
      for (const callback of subscriptions) callback();
    },
    model(file = "/hidden.toy") {
      const value = {
        language: "plaintext",
        text: "unsaved 😀",
        undo: ["first", "second"],
        disposed: false,
      };
      const model = {
        uri: { path: file, fsPath: file, toString: () => `file://${file}` },
        isDisposed: () => value.disposed,
        getLanguageId: () => value.language,
      } as unknown as editor.ITextModel;
      models.add(model);
      values.set(model, value);
      for (const callback of created) callback(model);
      return model;
    },
    remove(model: editor.ITextModel) {
      for (const callback of removing) callback(model);
      values.get(model)!.disposed = true;
      models.delete(model);
    },
  };
}

it("installs atomically, reuses a shell, and does not register aliases or extensions", () => {
  const value = language();
  const h = harness();
  const model = h.model();
  h.publish(ready(catalog(1, [value])));
  expect(h.register.mock.calls).toEqual([[{ id: "toy" }]]);
  expect(h.values.get(model)!.language).toBe("toy");
  h.publish(ready(catalog(1, [value])));
  expect(h.tokens).toHaveBeenCalledOnce();
  h.publish(ready(catalog(2, [])));
  expect(h.values.get(model)!.language).toBe("plaintext");
  expect(h.tokenDisposals[0]).toHaveBeenCalledOnce();
  expect(h.configurationDisposals[0]).toHaveBeenCalledOnce();
  h.publish(ready(catalog(3, [value])));
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.tokens).toHaveBeenCalledTimes(2);
  expect(h.values.get(model)!.language).toBe("toy");
  h.registrar.dispose();
});

it("rolls back a partial install and quarantines the generation across revisions", async () => {
  const h = harness();
  const model = h.model();
  h.configuration.mockImplementationOnce(() => {
    throw new Error("Monaco failure");
  });
  h.report.mockRejectedValueOnce(new Error("report IPC unavailable"));
  h.publish(ready(catalog(1, [language()])));
  expect(h.tokenDisposals[0]).toHaveBeenCalledOnce();
  expect(h.registrar.getActiveOwners()).toEqual([]);
  expect(h.values.get(model)!.language).toBe("plaintext");
  expect(h.report).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceKey: "development:toy",
      generation: 1,
      languageId: "toy",
      revision: 1,
      reason: "monaco",
    }),
  );
  h.publish(ready(catalog(2, [language()])));
  expect(h.tokens).toHaveBeenCalledOnce();
  expect(h.report).toHaveBeenCalledOnce();
  h.publish(ready(catalog(3, [language("toy", 2)])));
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.values.get(model)!.language).toBe("toy");
  await flush();
  h.registrar.dispose();
});

it("distinguishes reload withdrawal from quarantine while the fresh catalog is delayed", async () => {
  let advertised = catalog(1, [language()]);
  let heldCatalog: Promise<StaticLanguagesCatalog> | undefined;
  let emit!: (event: PluginEvent) => void;
  const store = createStaticLanguageStore({
    state: async () => state(advertised),
    staticLanguages: async () => heldCatalog ?? advertised,
    onEvent(listener) {
      emit = listener;
      return () => {};
    },
  });
  const h = harness(undefined, store);
  const model = h.model();
  const publish = async (value: StaticLanguagesCatalog) => {
    advertised = value;
    emit({ type: "state", state: state(value) });
    await flush();
  };
  try {
    await store.ready();
    await publish(catalog(2, []));
    await publish(catalog(3, [language()]));
    expect(h.configuration).toHaveBeenCalledTimes(2);
    h.configuration.mockImplementationOnce(() => {
      throw new Error("Second-half registration failure");
    });
    const accepted = deferred<{ accepted: boolean; revision: number }>();
    h.report.mockReturnValueOnce(accepted.promise);

    // Reload withdraws generation 1 before offering generation 2. Both old smoke
    // predicates pass here, even though configuration has not failed yet.
    await publish(catalog(4, []));
    const delayed = deferred<StaticLanguagesCatalog>();
    heldCatalog = delayed.promise;
    const reloaded = catalog(5, [language("toy", 2)]);
    await publish(reloaded);
    expect(h.registrar.resolve({ file: "main.toy" }).monacoLanguage).toBe("plaintext");
    expect(store.getSnapshot().catalog.languages).toEqual([]);
    expect(store.getSnapshot().phase).toBe("loading");
    expect(h.report).not.toHaveBeenCalled();
    const prematureAttempts = h.configuration.mock.calls.length;

    // A refresh can deliver the new generation first. Its first attempt is not
    // a quarantine retry: the old smoke would incorrectly compare 3 with 2.
    heldCatalog = undefined;
    await store.refresh();
    expect(h.configuration).toHaveBeenCalledTimes(prematureAttempts + 1);
    expect(h.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        generation: 2,
        languageId: "toy",
        revision: 5,
        reason: "monaco",
      }),
    );
    expect(h.values.get(model)!.language).toBe("plaintext");
    await store.refresh();
    expect(h.configuration).toHaveBeenCalledTimes(3);

    // Only the accepted failure and its ready catalog establish quarantine.
    accepted.resolve({ accepted: true, revision: 6 });
    await publish(catalog(6, []));
    delayed.resolve(reloaded);
    await flush();
    const attempts = h.configuration.mock.calls.length;
    await store.refresh();
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", targetRevision: 6 });
    expect(h.configuration).toHaveBeenCalledTimes(attempts);
    expect(h.report).toHaveBeenCalledOnce();

    await publish(catalog(7, [language("toy", 3)]));
    expect(h.configuration).toHaveBeenCalledTimes(attempts + 1);
    expect(h.values.get(model)!.language).toBe("toy");
    expect(h.register).toHaveBeenCalledOnce();
  } finally {
    h.registrar.dispose();
    store.dispose();
  }
});

it("reports every language in a catalog with an unsupported DTO version", async () => {
  const h = harness();
  const dto = catalog(1, [language("first"), language("second"), language("third")]);
  Object.assign(dto, { limitsVersion: 2 });
  h.publish(ready(dto));
  await flush();
  expect(
    h.report.mock.calls.map(([report]) => [report.languageId, report.reason, report.revision]),
  ).toEqual([
    ["first", "dto-version", 1],
    ["second", "dto-version", 1],
    ["third", "dto-version", 1],
  ]);
  expect(h.registrar.getActiveOwners()).toEqual([]);
  h.publish(ready(dto));
  await flush();
  expect(h.report).toHaveBeenCalledTimes(3);
  h.registrar.dispose();
});

it("releases a tracked model even when its disposal hook throws", () => {
  const h = harness(ready(catalog(1, [language()])));
  const model = h.model();
  const beforeChange = vi.fn();
  const lease = h.registrar.trackModel(model, () => ({ file: "/hidden.toy" }), {
    beforeChange,
    afterChange() {},
  });
  beforeChange.mockImplementation(() => {
    throw new Error("Disposal hook failed");
  });
  expect(() => h.remove(model)).toThrow("Disposal hook failed");
  expect(h.registrar.getRoute(model)).toBeUndefined();
  beforeChange.mockClear();
  lease.dispose();
  h.registrar.refreshModels();
  h.registrar.dispose();
  expect(beforeChange).not.toHaveBeenCalled();
});

it("publishes model route changes to status subscribers without a catalog change", () => {
  const h = harness(ready(catalog(1, [language()])));
  const model = h.model();
  let file = "/hidden.toy";
  const lease = h.registrar.trackModel(model, () => ({ file }));
  const routes: (string | undefined)[] = [];
  const off = h.registrar.subscribe(() => routes.push(h.registrar.getRoute(model)?.monacoLanguage));
  file = "/renamed.txt";
  h.registrar.refreshModels();
  expect(routes).toEqual(["plaintext"]);
  off();
  lease.dispose();
  h.registrar.dispose();
});

it.each(["dto-version", "validation", "adapter"] as const)(
  "reports %s without exposing a route",
  (reason) => {
    const h = harness();
    const value = language();
    const dto = catalog(1, [value]);
    if (reason === "dto-version") Object.assign(dto, { limitsVersion: 2 });
    if (reason === "validation")
      validate.mockReturnValueOnce({
        ok: false,
        problems: [{ message: "😀".repeat(3000), detail: { languageId: "toy" } }],
      });
    if (reason === "adapter")
      value.tokenizer.states[0]!.rules = [
        { regex: { pattern: "[", flags: "" }, action: { token: "identifier" } },
      ];
    h.publish(ready(dto));
    expect(h.report.mock.calls[0]![0].reason).toBe(reason);
    expect(Array.from(h.report.mock.calls[0]![0].detail).length).toBeLessThanOrEqual(2048);
    expect(h.registrar.getActiveOwners()).toEqual([]);
    expect(h.register).not.toHaveBeenCalled();
    h.registrar.dispose();
  },
);

it("keeps provisional ambiguity from complete owner metadata, including uninstalled owners", () => {
  const a = language("toy-a", 1, ["toy", "a"]);
  const b = language("toy-b", 1, ["toy", "b"]);
  const old = catalog(1, [a]);
  const h = harness(ready(old));
  const global = h.model();
  const bound = h.model("/bound.toy");
  h.registrar.trackModel(bound, () => ({ file: "/bound.toy", binding: bindingFor(a) }));
  h.publish({ phase: "loading", targetRevision: 2, owners: [owner(a), owner(b)], catalog: old });
  expect(h.values.get(global)!.language).toBe("plaintext");
  expect(h.values.get(bound)!.language).toBe("toy-a");
  expect(h.registrar.resolve({ file: "main.a" }).monacoLanguage).toBe("toy-a");
  expect(h.registrar.resolve({ file: "main.b", binding: bindingFor(b) }).monacoLanguage).toBe(
    "plaintext",
  );
  expect(h.tokenDisposals[0]).not.toHaveBeenCalled();
  h.publish({
    phase: "failed",
    targetRevision: 2,
    owners: [owner(a), owner(b)],
    catalog: old,
    error: "offline",
  });
  expect(h.values.get(global)!.language).toBe("plaintext");
  // A later metadata-only update cannot undo ambiguity learned while a fetch was pending.
  h.publish({ phase: "loading", targetRevision: 3, owners: [owner(a)], catalog: old });
  expect(h.values.get(global)!.language).toBe("plaintext");
  expect(h.values.get(bound)!.language).toBe("toy-a");
  expect(h.registrar.resolve({ file: "main.a" }).monacoLanguage).toBe("toy-a");
  h.publish(ready(catalog(3, [a])));
  expect(h.values.get(global)!.language).toBe("toy-a");
  h.registrar.dispose();
});

it.each(["budget-loser", "marker-filtered", "quarantined-claimant"] as const)(
  "preserves %s ambiguity through pending, failed, and completed catalog fetches",
  async (kind) => {
    const first = authoritativeCatalog(kind, 1);
    let advertised = first;
    const replies = Array.from({ length: 4 }, () => deferred<StaticLanguagesCatalog>());
    let index = 0;
    let emit!: (event: PluginEvent) => void;
    const store = createStaticLanguageStore({
      state: async () => state(advertised),
      staticLanguages: () => replies[index++]!.promise,
      onEvent(listener) {
        emit = listener;
        return () => {};
      },
    });
    const h = harness(undefined, store);
    const global = h.model("/global.shared");
    const unrelated = h.model("/unrelated.x1");
    const bound = h.model("/bound.shared");
    const selected = first.languages[0]!;
    h.registrar.trackModel(bound, () => ({
      file: "/bound.shared",
      binding: bindingFor(selected),
    }));
    const expectRoutes = () => {
      expect(h.values.get(global)!.language).toBe("plaintext");
      expect(h.values.get(unrelated)!.language).toBe("lang1");
      expect(h.values.get(bound)!.language).toBe("lang0");
      expect(h.registrar.resolve({ file: "/core.json" }).monacoLanguage).toBe("json");
      expect(h.report).not.toHaveBeenCalled();
      for (const dispose of [...h.tokenDisposals, ...h.configurationDisposals])
        expect(dispose).not.toHaveBeenCalled();
    };
    await flush();
    replies[0]!.resolve(first);
    await store.ready();
    expect(store.getSnapshot().phase).toBe("ready");
    expect(h.registrar.getActiveOwners()).toHaveLength(first.languages.length);
    expectRoutes();

    // Only one admitted owner claims shared, but the host's null is still authoritative.
    advertised = authoritativeCatalog(kind, 2);
    emit({ type: "state", state: state(advertised) });
    expect(store.getSnapshot()).toMatchObject({
      phase: "loading",
      targetRevision: 2,
      catalog: { revision: 1 },
    });
    expectRoutes();
    replies[1]!.reject(new Error("latest catalog unavailable"));
    await flush();
    expect(store.getSnapshot().phase).toBe("failed");
    expectRoutes();
    const refresh = store.refresh();
    await flush();
    replies[2]!.resolve(advertised);
    await refresh;
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", targetRevision: 2 });
    expectRoutes();
    expect(
      h.setModelLanguage.mock.calls.some(([model, id]) => model === global && id !== "plaintext"),
    ).toBe(false);

    // The host later resolves the conflict. Metadata alone cannot authorize a winner;
    // only the matching complete catalog may restore the global route.
    advertised = catalog(3, first.languages);
    emit({ type: "state", state: state(advertised) });
    const newlyCreated = h.model("/new.shared");
    expect(h.values.get(newlyCreated)!.language).toBe("plaintext");
    expectRoutes();
    replies[3]!.resolve(advertised);
    await flush();
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", targetRevision: 3 });
    expect(h.values.get(global)!.language).toBe("lang0");
    expect(h.values.get(newlyCreated)!.language).toBe("lang0");
    expect(h.values.get(unrelated)!.language).toBe("lang1");
    expect(h.register).toHaveBeenCalledTimes(first.languages.length);
    expect(h.tokens).toHaveBeenCalledTimes(first.languages.length);
    expect(h.report).not.toHaveBeenCalled();
    h.registrar.dispose();
    store.dispose();
  },
);

it("does not promote the survivor when a conflicting owner disappears before the catalog", () => {
  const a = language("toy-a", 1, ["shared", "a"]);
  const b = language("toy-b", 1, ["shared", "b"]);
  const safe = language("unrelated", 1, ["safe"]);
  const first = catalog(1, [a, b, safe]);
  const h = harness(ready(first));
  const global = h.model("/global.shared");
  const unrelated = h.model("/unrelated.safe");
  h.publish({
    phase: "loading",
    targetRevision: 2,
    owners: [owner(a), owner(safe)],
    catalog: first,
  });
  expect(h.values.get(global)!.language).toBe("plaintext");
  expect(h.values.get(unrelated)!.language).toBe("unrelated");
  expect(h.registrar.resolve({ file: "/main.shared", binding: bindingFor(a) }).monacoLanguage).toBe(
    "toy-a",
  );
  expect(h.registrar.resolve({ file: "/main.shared", binding: bindingFor(b) }).monacoLanguage).toBe(
    "plaintext",
  );
  expect(h.tokenDisposals[1]).toHaveBeenCalledOnce();
  expect(h.tokenDisposals[0]).not.toHaveBeenCalled();
  h.publish(ready(catalog(2, [a, safe])));
  expect(h.values.get(global)!.language).toBe("toy-a");
  expect(h.values.get(unrelated)!.language).toBe("unrelated");
  h.registrar.dispose();
});

it("revokes hidden and newly created diff models before a stale catalog resolves", async () => {
  const first = catalog(1, [language()]);
  const replies = [
    deferred<StaticLanguagesCatalog>(),
    deferred<StaticLanguagesCatalog>(),
    deferred<StaticLanguagesCatalog>(),
  ];
  let emit!: (event: PluginEvent) => void;
  let index = 0;
  const store = createStaticLanguageStore({
    state: async () => state(first),
    staticLanguages: () => replies[index++]!.promise,
    onEvent(listener) {
      emit = listener;
      return () => {};
    },
  });
  const h = harness(undefined, store);
  const hidden = h.model("/hidden.toy");
  const original = h.model("/original.toy");
  const values = [hidden, original].map((model) => h.values.get(model)!);
  const undo = values.map((value) => value.undo);
  for (const model of [hidden, original])
    h.registrar.trackModel(model, () => ({ file: model.uri.path }), {
      beforeChange() {
        h.log.push("detach");
      },
      afterChange() {},
    });
  await flush();
  replies[0]!.resolve(first);
  await store.ready();
  const stale = store.refresh();
  await flush();
  h.log.length = 0;
  emit({ type: "state", state: state(catalog(2, [])) });
  const modified = h.model("/modified.toy");
  expect([hidden, original, modified].map((model) => h.values.get(model)!.language)).toEqual([
    "plaintext",
    "plaintext",
    "plaintext",
  ]);
  expect(h.log.indexOf("detach")).toBeLessThan(h.log.indexOf("dispose:tokens"));
  replies[1]!.resolve(first);
  await stale;
  replies[2]!.reject(new Error("latest fetch failed"));
  await flush();
  expect(h.registrar.getActiveOwners()).toEqual([]);
  expect(values.map((value) => value.text)).toEqual(["unsaved 😀", "unsaved 😀"]);
  values.forEach((value, i) => expect(value.undo).toBe(undo[i]));
  expect(h.register).toHaveBeenCalledOnce();
  h.registrar.dispose();
  store.dispose();
});

it("restores renamed drafts across failed generations without registering a shell twice", () => {
  const h = harness(ready(catalog(1, [language()])));
  const model = h.model();
  const value = h.values.get(model)!;
  const undo = value.undo;
  let context: StaticModelContext = { file: "/old.toy", workspaceId: "one" };
  const after = vi.fn();
  h.registrar.trackModel(model, () => context, { beforeChange() {}, afterChange: after });
  context = { file: "/renamed.json", workspaceId: "one" };
  h.registrar.refreshModels();
  expect(value.language).toBe("json");
  h.configuration.mockImplementationOnce(() => {
    throw new Error("bad reload");
  });
  h.publish(ready(catalog(2, [language("toy", 2)])));
  context = { file: "/renamed.toy", workspaceId: "two" };
  h.registrar.refreshModels();
  expect(value.language).toBe("plaintext");
  h.publish(ready(catalog(3, [language("toy", 2)])));
  expect(h.tokens).toHaveBeenCalledTimes(2);
  h.publish(ready(catalog(4, [language("toy", 3)])));
  expect(value.language).toBe("toy");
  expect(value.text).toBe("unsaved 😀");
  expect(value.undo).toBe(undo);
  expect(h.register).toHaveBeenCalledOnce();
  expect(after.mock.calls.at(-1)![0]).toMatchObject({
    catalogRevision: 4,
    staticOwner: { generation: 3 },
  });
  h.registrar.dispose();
});

it("allows id 256, refuses id 257, and retains the shell count after revocation", () => {
  const h = harness();
  for (let index = 1; index <= 257; index++)
    h.publish(ready(catalog(index, [language(`toy-${index}`)])));
  expect(h.register).toHaveBeenCalledTimes(256);
  expect(h.report.mock.calls.at(-1)![0]).toMatchObject({
    languageId: "toy-257",
    reason: "session-language-ids",
  });
  h.publish(ready(catalog(258, [language("toy-1", 2)])));
  expect(h.registrar.resolve({ file: "main.toy" }).monacoLanguage).toBe("toy-1");
  expect(h.register).toHaveBeenCalledTimes(256);
  h.registrar.dispose();
});

it("releases tracking leases safely and preserves shell history across manager recreation", () => {
  const h = harness(ready(catalog(1, [language()])));
  const model = h.model();
  const context = () => ({ file: "/main.toy" });
  const hooks = { beforeChange: vi.fn(), afterChange: vi.fn() };
  const first = h.registrar.trackModel(model, context, hooks);
  const second = h.registrar.trackModel(model, context, hooks);
  const attached = hooks.afterChange.mock.calls.length;
  first.dispose();
  expect(hooks.afterChange.mock.calls.length).toBe(attached);
  h.publish(ready(catalog(2, [])));
  expect(hooks.beforeChange).toHaveBeenCalled();
  second.dispose();
  second.dispose();
  h.remove(model);
  expect(h.registrar.getRoute(model)).toBeUndefined();
  h.registrar.dispose();
  h.registrar.dispose();
  expect(h.created.size).toBe(0);
  expect(h.removing.size).toBe(0);
  expect(h.subscriptions.size).toBe(0);
  h.publish(ready(catalog(3, [language()])));
  const existing = h.model("/already-live.toy");
  const replacement = createStaticLanguageRegistrar(h.input);
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.values.get(existing)!.language).toBe("toy");
  replacement.dispose();
});

it("updates aliases and extension metadata without reinstalling unchanged resources", () => {
  const initial = language();
  const h = harness(ready(catalog(1, [initial])));
  const model = h.model();
  const binding = bindingFor(initial);
  const context = { file: "/main.toy", binding };
  h.registrar.trackModel(model, () => context);
  h.publish(ready(catalog(2, [{ ...initial, aliases: ["Renamed 😀"] }])));
  expect(h.registrar.getRoute(model)).toMatchObject({
    displayName: "Renamed 😀",
    catalogRevision: 2,
  });
  expect(binding.epoch).toBe(11);
  expect(h.tokens).toHaveBeenCalledOnce();
  h.publish({
    phase: "loading",
    targetRevision: 3,
    owners: [{ ...owner(initial), extensions: ["new"] }],
    catalog: catalog(2, [initial]),
  });
  expect(h.values.get(model)!.language).toBe("plaintext");
  expect(h.registrar.resolve({ file: "/main.new" }).monacoLanguage).toBe("plaintext");
  const changed = { ...initial, extensions: ["new"] };
  expect(
    h.registrar.resolve({ file: "/main.new", binding: bindingFor(changed) }).monacoLanguage,
  ).toBe("toy");
  expect(h.tokenDisposals[0]).not.toHaveBeenCalled();
  h.publish(ready(catalog(3, [changed])));
  expect(h.registrar.resolve({ file: "/main.new" }).monacoLanguage).toBe("toy");
  expect(h.tokens).toHaveBeenCalledOnce();
  h.registrar.dispose();
});

it.each(["context", "beforeChange", "afterChange", "setModelLanguage"] as const)(
  "disposes revoked providers and reconciles other models when %s throws",
  (failure) => {
    const h = harness(ready(catalog(1, [language()])));
    const broken = h.model("/broken.toy");
    const healthy = h.model("/healthy.toy");
    let throwing = false;
    const maybeThrow = (stage: string) => {
      if (throwing && stage === failure) throw new Error("Broken model attachment");
    };
    h.registrar.trackModel(
      broken,
      () => {
        maybeThrow("context");
        return { file: "/broken.toy" };
      },
      {
        beforeChange() {
          maybeThrow("beforeChange");
        },
        afterChange() {
          maybeThrow("afterChange");
        },
      },
    );
    if (failure === "setModelLanguage")
      h.setModelLanguage.mockImplementation((model, id) => {
        if (model === broken) maybeThrow("setModelLanguage");
        h.values.get(model)!.language = id;
      });
    throwing = true;
    expect(() => h.publish(ready(catalog(2, [])))).not.toThrow();
    expect(h.values.get(healthy)!.language).toBe("plaintext");
    expect(h.registrar.getActiveOwners()).toEqual([]);
    expect(h.tokenDisposals[0]).toHaveBeenCalledOnce();
    expect(h.configurationDisposals[0]).toHaveBeenCalledOnce();
    throwing = false;
    h.registrar.refreshModels();
    expect(h.values.get(broken)!.language).toBe("plaintext");
    h.registrar.dispose();
  },
);

it("reinstalls a changed resourceDigest under the same owner and generation", () => {
  const initial = language();
  const h = harness(ready(catalog(1, [initial])));
  const model = h.model();
  const changed = { ...initial, resourceDigest: "changed-bytes" };
  h.publish(ready(catalog(2, [changed])));
  expect(h.register).toHaveBeenCalledOnce();
  expect(h.tokens).toHaveBeenCalledTimes(2);
  expect(h.configuration).toHaveBeenCalledTimes(2);
  expect(h.tokenDisposals[0]).toHaveBeenCalledOnce();
  expect(h.configurationDisposals[0]).toHaveBeenCalledOnce();
  expect(h.values.get(model)!.language).toBe("toy");
  h.registrar.dispose();
});

it("protects every projected core id without claiming implicit core extensions", () => {
  const h = harness();
  let revision = 1;
  for (const id of CORE_LANGUAGE_IDS) h.publish(ready(catalog(revision++, [language(id)])));
  expect(h.register).not.toHaveBeenCalled();
  expect(h.report).toHaveBeenCalledTimes(CORE_LANGUAGE_IDS.size);
  expect(h.registrar.resolve({ file: "main.JSON" }).monacoLanguage).toBe("json");
  for (const extension of ["py", "ts", "js"]) {
    expect(h.registrar.resolve({ file: `main.${extension}` }).monacoLanguage).toBe("plaintext");
  }
  h.registrar.dispose();
});

it("installs a late equal-revision catalog after bootstrap timeout plaintext fallback", async () => {
  vi.useFakeTimers();
  const first = catalog(7, [language()]);
  const reply = deferred<StaticLanguagesCatalog>();
  const store = createStaticLanguageStore({
    state: async () => state(first),
    staticLanguages: () => reply.promise,
    onEvent: () => () => {},
  });
  const h = harness(undefined, store);
  try {
    const model = h.model();
    const boot = bootstrapStaticLanguages({ store, registrar: h.registrar });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await boot).toMatchObject({ kind: "plaintext", reason: "timeout" });
    expect(h.registrar.getRoute(model)).toMatchObject({
      catalogRevision: 7,
      monacoLanguage: "plaintext",
    });
    reply.resolve(first);
    await store.ready();
    expect(store.getSnapshot()).toMatchObject({ phase: "ready", targetRevision: 7 });
    expect(h.values.get(model)!.language).toBe("toy");
    expect(h.register).toHaveBeenCalledOnce();
  } finally {
    h.registrar.dispose();
    store.dispose();
    vi.useRealTimers();
  }
});

it("boundary session distinct ids at zero one 255 256 257", () => {
  const h = harness();
  expect(h.register).not.toHaveBeenCalled();
  for (let index = 1; index <= 257; index++) {
    h.publish(ready(catalog(index, [language(`boundary-${index}`)])));
    if ([1, 255, 256, 257].includes(index)) {
      expect(h.register).toHaveBeenCalledTimes(Math.min(index, 256));
      expect(h.registrar.resolve({ file: "main.toy" }).monacoLanguage).toBe(
        index <= 256 ? `boundary-${index}` : "plaintext",
      );
      if (index <= 256) expect(h.report).not.toHaveBeenCalled();
    }
  }
  expect(h.report).toHaveBeenCalledTimes(1);
  expect(h.report.mock.calls[0]![0]).toMatchObject({
    languageId: "boundary-257",
    reason: "session-language-ids",
  });
  h.publish(ready(catalog(258, [])));
  h.publish(ready(catalog(259, [language("boundary-1", 2)])));
  expect(h.registrar.resolve({ file: "main.toy" }).monacoLanguage).toBe("boundary-1");
  expect(h.register).toHaveBeenCalledTimes(256);
  h.registrar.dispose();
});
