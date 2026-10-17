import { expect, it, vi } from "vitest";
import type { PluginEvent, PluginsView } from "../../shared/plugins.js";
import type {
  StaticLanguagesCatalog,
  ValidatedStaticLanguage,
} from "../../shared/static-languages.js";
import { createStaticLanguageStore } from "./static-language-store.js";
import { resolveLexicalLanguage } from "./static-language-routing.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const language: ValidatedStaticLanguage = {
  id: "toy",
  pluginId: "acme.toy",
  sourceKey: "development:toy",
  generation: 1,
  extensions: ["toy"],
  aliases: ["Toy"],
  resourceDigest: "one",
  tokenizer: { ignoreCase: false, states: [{ name: "root", rules: [] }] },
  configuration: {},
  resourceBytes: { tokenizer: 64, configuration: 3 },
  expandedRules: 0,
};
function catalog(revision: number, languages = [language]): StaticLanguagesCatalog {
  return {
    revision,
    formatVersion: 1,
    limitsVersion: 1,
    languages,
    extensionRoutes: languages.length ? { toy: "toy" } : {},
    conflicts: [],
  };
}
// Fixed outputs at the T2/T3 boundary; do not reimplement their admission/filter logic.
// T2's 129 valid candidates leave 128 DTOs and both conflict sources. T3's marker
// failure leaves only builtin DTOs and removes the cross-source conflict detail.
function authoritativeCatalog(
  kind: "budget-loser" | "marker-filtered" | "quarantined-claimant",
  revision: number,
): StaticLanguagesCatalog {
  const languages = Array.from({ length: kind === "budget-loser" ? 128 : 2 }, (_, index) => ({
    ...language,
    id: `lang${index}`,
    pluginId: `test.i${String(index).padStart(3, "0")}`,
    sourceKey: `builtin:test.i${String(index).padStart(3, "0")}`,
    extensions: [index === 0 ? "shared" : `x${index}`],
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
function state(value: StaticLanguagesCatalog): PluginsView {
  return {
    revision: value.revision,
    diagnosticHelpRevision: 0,
    staticLanguagesRevision: value.revision,
    staticLanguageOwners: value.languages.map((item) => ({
      pluginId: item.pluginId,
      sourceKey: item.sourceKey,
      generation: item.generation,
      languageId: item.id,
      extensions: item.extensions,
    })),
    safeMode: false,
    developmentMode: true,
    plugins: [],
    developer: { enabled: true, commandLine: false, linkedCount: 0 },
    origins: {},
    python: { pendingReload: [] },
    inflight: [],
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  const order: string[] = [];
  const events = new Set<(event: PluginEvent) => void>();
  const firstState = deferred<PluginsView>();
  const replies: ReturnType<typeof deferred<StaticLanguagesCatalog>>[] = [];
  const api = {
    onEvent(listener: (event: PluginEvent) => void) {
      order.push("subscribe");
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    state: vi.fn(() => {
      order.push("state");
      return firstState.promise;
    }),
    staticLanguages: vi.fn(() => {
      const reply = deferred<StaticLanguagesCatalog>();
      replies.push(reply);
      order.push("catalog");
      return reply.promise;
    }),
  };
  const store = createStaticLanguageStore(api);
  return {
    store,
    api,
    order,
    events,
    replies,
    firstState,
    emit(value: PluginsView) {
      for (const listener of events) listener({ type: "state", state: value });
    },
  };
}

it("subscribes before fetching and never accepts a catalog below the highest target", async () => {
  const h = setup();
  expect(h.order.slice(0, 2)).toEqual(["subscribe", "state"]);
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.emit(state(catalog(2, [])));
  expect(h.store.getSnapshot()).toMatchObject({ targetRevision: 2, owners: [] });
  h.replies[1]!.resolve(catalog(2, []));
  await h.store.ready();
  h.replies[0]!.resolve(catalog(1));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "ready",
    targetRevision: 2,
    catalog: { revision: 2, languages: [] },
  });
  h.store.dispose();
});

it("publishes revocation metadata synchronously even when the new fetch fails", async () => {
  const h = setup();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[0]!.resolve(catalog(1));
  await h.store.ready();
  const listener = vi.fn();
  const off = h.store.subscribe(listener);
  h.emit(state(catalog(2, [])));
  expect(h.store.getSnapshot().owners).toEqual([]);
  expect(listener).toHaveBeenCalledOnce();
  h.replies[1]!.reject(new Error("unavailable"));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({ phase: "failed", targetRevision: 2, owners: [] });
  off();
  h.store.dispose();
});

it("clears malformed owner metadata and recovers only with a consistent catalog", async () => {
  const h = setup();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[0]!.resolve(catalog(1));
  await h.store.ready();
  h.emit({ ...state(catalog(2)), staticLanguageOwners: null } as unknown as PluginsView);
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    targetRevision: 2,
    owners: [],
    catalog: { languages: [], extensionRoutes: {} },
  });
  h.replies[1]!.resolve(catalog(2));
  await flush();
  expect(h.store.getSnapshot().phase).toBe("ready");
  h.emit(state(catalog(3, [])));
  h.replies[2]!.resolve(catalog(3));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    owners: [],
    catalog: { languages: [] },
  });
  h.store.dispose();
});

it("settles initial failure, supports manual refresh, and ignores disposed completions", async () => {
  const h = setup();
  h.firstState.reject(new Error("offline"));
  await h.store.ready();
  expect(h.store.getSnapshot().phase).toBe("failed");
  h.api.state.mockResolvedValue(state(catalog(4)));
  const refresh = h.store.refresh();
  await flush();
  h.replies[0]!.resolve(catalog(4));
  await refresh;
  expect(h.store.getSnapshot().phase).toBe("ready");
  h.emit(state(catalog(5, [])));
  const before = h.store.getSnapshot();
  h.store.dispose();
  h.store.dispose();
  h.replies[1]!.resolve(catalog(5, []));
  await flush();
  expect(h.store.getSnapshot()).toBe(before);
  expect(h.events.size).toBe(0);
});

it("passes numeric unsupported versions to the registrar but rejects invalid route identities", async () => {
  const h = setup();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[0]!.resolve({ ...catalog(1), formatVersion: 2 } as unknown as StaticLanguagesCatalog);
  await h.store.ready();
  expect(h.store.getSnapshot().catalog.formatVersion).toBe(2);
  h.emit(state(catalog(2)));
  h.replies[1]!.resolve({ ...catalog(2), extensionRoutes: { toy: "foreign" } });
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    owners: [],
    catalog: { languages: [] },
  });
  h.store.dispose();
});

it.each(["budget-loser", "marker-filtered", "quarantined-claimant"] as const)(
  "accepts the %s catalog without electing its sole delivered claimant",
  async (kind) => {
    const h = setup();
    const value = authoritativeCatalog(kind, 1);
    expect(value.languages).toHaveLength(kind === "budget-loser" ? 128 : 2);
    expect(value.languages.filter((item) => item.extensions.includes("shared"))).toHaveLength(1);
    expect(value.conflicts).toHaveLength(kind === "budget-loser" ? 1 : 0);
    h.firstState.resolve(state(value));
    await flush();
    h.replies[0]!.resolve(value);
    await h.store.ready();
    const snapshot = h.store.getSnapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.catalog).toEqual(value);
    expect(snapshot.owners).toEqual(state(value).staticLanguageOwners);
    const route = (file: string) =>
      resolveLexicalLanguage({
        file,
        catalog: snapshot.catalog,
        activeOwners: snapshot.owners,
        coreExtensionRoutes: { json: "json" },
      });
    expect(route("main.shared").monacoLanguage).toBe("plaintext");
    expect(route("main.x1").monacoLanguage).toBe("lang1");
    expect(route("main.json").monacoLanguage).toBe("json");
    h.store.dispose();
  },
);

it("accepts a conservative null route even with no delivered claimant or conflict detail", async () => {
  const h = setup();
  const value = { ...catalog(1, []), extensionRoutes: { shared: null } };
  h.firstState.resolve(state(value));
  await flush();
  h.replies[0]!.resolve(value);
  await h.store.ready();
  expect(h.store.getSnapshot()).toMatchObject({ phase: "ready", catalog: value });
  h.store.dispose();
});

it.each(["missing-id", "wrong-extension", "multiple-claimants", "resource-budget"] as const)(
  "still rejects %s alongside an authoritative null route",
  async (kind) => {
    const h = setup();
    const value = catalog(1);
    value.extensionRoutes = { shared: null, toy: "toy" };
    if (kind === "missing-id") value.extensionRoutes.toy = "absent";
    if (kind === "wrong-extension") value.extensionRoutes = { shared: null, absent: "toy" };
    if (kind === "multiple-claimants")
      value.languages = [language, { ...language, id: "other", sourceKey: "development:other" }];
    if (kind === "resource-budget")
      value.languages = [
        {
          ...language,
          // Both files fit 512 KiB, but their sum exceeds the 768 KiB language budget.
          resourceBytes: { tokenizer: 524288, configuration: 524288 },
        },
      ];
    h.firstState.resolve(state(value));
    await flush();
    h.replies[0]!.resolve(value);
    await h.store.ready();
    expect(h.store.getSnapshot()).toMatchObject({
      phase: "failed",
      owners: [],
      catalog: { languages: [], extensionRoutes: {} },
    });
    h.store.dispose();
  },
);

it("measures non-BMP display aliases in code points at the envelope boundary", async () => {
  const h = setup();
  const valid = catalog(1, [{ ...language, aliases: ["😀".repeat(80)] }]);
  h.firstState.resolve(state(valid));
  await flush();
  h.replies[0]!.resolve(valid);
  await h.store.ready();
  expect(h.store.getSnapshot().catalog.languages[0]!.aliases[0]!.length).toBe(160);
  const invalid = catalog(2, [{ ...language, aliases: ["😀".repeat(81)] }]);
  h.emit(state(invalid));
  h.replies[1]!.resolve(invalid);
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "failed",
    owners: [],
    catalog: { languages: [] },
  });
  h.store.dispose();
});

it("ignores an initial state reply that arrives after a newer event and catalog", async () => {
  const h = setup();
  h.emit(state(catalog(2, [])));
  h.replies[0]!.resolve(catalog(2, []));
  await h.store.ready();
  h.firstState.resolve(state(catalog(1)));
  await flush();
  h.replies[1]!.resolve(catalog(1));
  await flush();
  expect(h.store.getSnapshot()).toMatchObject({
    phase: "ready",
    targetRevision: 2,
    catalog: { revision: 2, languages: [] },
  });
  h.store.dispose();
});
