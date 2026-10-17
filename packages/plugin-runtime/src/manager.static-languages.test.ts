import type * as Registry from "./registry.js";
import type * as Protocol from "@kobrixa/plugin-protocol";
import type * as FsPromises from "node:fs/promises";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  staticLanguageDeclarationProblems,
  validateStaticLanguageResources,
  type PluginManifest,
} from "@kobrixa/plugin-protocol";
import { PluginManager, type PluginManagerOptions, type PluginStateStore } from "./manager.js";
import { developmentSourceKey, readSource } from "./registry.js";
import {
  acceptFixture,
  builtinToy,
  developmentToy,
  toyManifest,
  writeManifest,
} from "./test-static-languages.js";
import { memoryPlugin } from "./test-process.js";

vi.mock("@kobrixa/plugin-protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof Protocol>()),
  staticLanguageDeclarationProblems: vi.fn(() => []),
  validateStaticLanguageResources: vi.fn((input) => acceptFixture(input)),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});
// Wrap the real metadata reader only to observe when healthy sources finish;
// filesystem I/O, SourceReadBudget and both manager orchestration paths remain real.
vi.mock("./registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>();
  return { ...actual, readSource: vi.fn(actual.readSource) };
});

let root: string;
const managers: PluginManager[] = [];
const launcher = vi.fn();
const store = (disabled: string[] = [], legacy: string[] = []): PluginStateStore => ({
  load: async () => ({ disabled: new Set(disabled), legacyDisabledIds: new Set(legacy) }),
  save: vi.fn(async () => {}),
});
async function create(
  sources: PluginManagerOptions["sources"],
  overrides: Partial<PluginManagerOptions> = {},
) {
  const manager = await PluginManager.create({
    sources,
    store: store(),
    safeMode: false,
    locale: "en",
    launcher,
    ...overrides,
  });
  managers.push(manager);
  return manager;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-manager-"));
  vi.clearAllMocks();
  vi.mocked(staticLanguageDeclarationProblems).mockReturnValue([]);
  vi.mocked(validateStaticLanguageResources).mockImplementation(acceptFixture);
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await rm(root, { recursive: true, force: true });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

for (const phase of ["startup", "refresh"] as const)
  for (const stage of ["metadata", "resource"] as const)
    it.each([false, true])(
      `isolates slow ${stage} during ${phase} in either source order (reverse: %s)`,
      async (reverse) => {
        // Pick the slow development source by sorted sourceKey so its resources
        // precede the healthy development source in the deterministic resource queue.
        const folders = await Promise.all([developmentToy(root, "a"), developmentToy(root, "b")]);
        folders.sort((a, b) =>
          developmentSourceKey(a.directory).localeCompare(developmentSourceKey(b.directory)),
        );
        const slow = folders[0]!;
        const healthy = folders[1]!;
        const slowKey = developmentSourceKey(slow.directory);
        const healthyKey = developmentSourceKey(healthy.directory);
        const slowManifest = structuredClone(toyManifest);
        slowManifest.id = "acme.slow";
        const declaration = slowManifest.contributes!.languages![0]!;
        slowManifest.contributes!.languages = ["a-ready", "b-slow", "c-unread"].map((id) => ({
          ...declaration,
          id,
          extensions: [id.replaceAll("-", "")],
          configuration: {
            version: 1,
            path: id === "b-slow" ? "slow.json" : declaration.configuration.path,
          },
        }));
        await writeManifest(slow.directory, slowManifest);
        await writeFile(path.join(slow.directory, "slow.json"), "{}");
        const healthyManifest = structuredClone(toyManifest);
        healthyManifest.id = "acme.healthy";
        healthyManifest.contributes!.languages![0]!.id = "healthy-dev";
        healthyManifest.contributes!.languages![0]!.extensions = ["healthydev"];
        await writeManifest(healthy.directory, healthyManifest);
        const bundled = builtinToy("test.healthy", "healthy-builtin", ["healthybuiltin"]);
        const sources = reverse ? [healthy, bundled, slow] : [slow, bundled, healthy];
        const blockedPath = path.join(
          await realpath(slow.directory),
          stage === "metadata" ? "kobrixa-plugin.json" : "slow.json",
        );
        let manager = phase === "refresh" ? await create(sources) : undefined;
        const actualOpen = vi.mocked(open).getMockImplementation()!;
        const actualReadSource = vi.mocked(readSource).getMockImplementation()!;
        const held = deferred();
        const entered = deferred();
        const healthyMetadata = deferred();
        const lateClosed = deferred();
        const completed = new Set<string>();
        let blocked = false;
        let elapsed = 0;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        vi.mocked(readSource).mockImplementation(async (...args) => {
          const read = await actualReadSource(...args);
          if (read.sourceKey === healthyKey || read.sourceKey === "builtin:test.healthy") {
            completed.add(read.sourceKey);
            if (completed.size === 2) healthyMetadata.resolve();
          }
          return read;
        });
        vi.mocked(open).mockImplementation(async (...args) => {
          const handle = await actualOpen(...args);
          if (!blocked && String(args[0]) === blockedPath) {
            blocked = true;
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close();
              lateClosed.resolve();
            };
            entered.resolve();
            await held.promise;
          }
          return handle;
        });
        const operation = manager
          ? manager.setEnabled(healthyKey, true)
          : create(sources).then((created) => {
              manager = created;
            });
        let settled = false;
        void operation.then(() => {
          settled = true;
        });
        try {
          await Promise.all([entered.promise, healthyMetadata.promise]);
          elapsed += 4999;
          await vi.advanceTimersByTimeAsync(4999);
          expect(settled).toBe(false);
          elapsed += 1;
          await vi.advanceTimersByTimeAsync(1);
          await operation;
          const catalog = manager!.staticLanguages();
          expect(catalog.languages.map((item) => item.id).sort()).toEqual(
            stage === "metadata"
              ? ["healthy-builtin", "healthy-dev"]
              : ["a-ready", "healthy-builtin", "healthy-dev"],
          );
          const rows = manager!.state().plugins;
          for (const key of [healthyKey, "builtin:test.healthy"]) {
            expect(rows.find((row) => row.sourceKey === key)).toMatchObject({
              status: "enabled",
              problems: [],
            });
          }
          const failed = rows.find((row) => row.sourceKey === slowKey)!;
          if (stage === "metadata") {
            expect(failed.status).toBe("invalid");
            expect(failed.problems.map((item) => item.code)).toEqual(["PLUGIN_E_SOURCE_TIMEOUT"]);
          } else {
            expect(failed.status).toBe("enabled");
            expect(failed.problems.map((item) => [item.code, item.detail?.languageId])).toEqual([
              ["PLUGIN_E_STATIC_LANGUAGE", "b-slow"],
              ["PLUGIN_E_STATIC_LANGUAGE", "c-unread"],
            ]);
            expect(failed.problems.every((item) => item.message.includes("deadline"))).toBe(true);
          }
          const snapshot = manager!.state();
          const validations = vi.mocked(validateStaticLanguageResources).mock.calls.length;
          held.resolve();
          await lateClosed.promise;
          await Promise.resolve();
          expect(manager!.staticLanguages()).toEqual(catalog);
          expect(manager!.state()).toEqual(snapshot);
          expect(validateStaticLanguageResources).toHaveBeenCalledTimes(validations);
          expect(launcher).not.toHaveBeenCalled();
        } finally {
          held.resolve();
          await operation;
          if (blocked) await lateClosed.promise;
          vi.mocked(open).mockImplementation(actualOpen);
          vi.mocked(readSource).mockImplementation(actualReadSource);
          clock.mockRestore();
          vi.useRealTimers();
        }
      },
    );

it("loads static, node and python lexical contributions without launch or handshake", async () => {
  for (const kind of ["static", "node", "python"] as const) {
    const source = await developmentToy(root, kind);
    const manifest = structuredClone(toyManifest);
    if (kind !== "static") {
      manifest.runtime = { kind, entry: "main.js" };
      await writeFile(path.join(source.directory, "main.js"), "");
    }
    await writeManifest(source.directory, manifest);
    const manager = await create([source]);
    expect(manager.staticLanguages().languages).toHaveLength(1);
    expect(manager.state().plugins[0]).toMatchObject({
      runtime: kind,
      status: "enabled",
      running: false,
    });
    expect(manager.active).toBe(false);
  }
  expect(launcher).not.toHaveBeenCalled();
});

it("loads diagnosticHelp-only static runtime without an entrypoint", async () => {
  const source = await developmentToy(root);
  const manifest = structuredClone(toyManifest);
  manifest.contributes = { diagnosticHelp: { version: 1, path: "help.json" } };
  await writeManifest(source.directory, manifest);
  await writeFile(
    path.join(source.directory, "help.json"),
    JSON.stringify({
      entries: [
        {
          code: "TOY001",
          title: { en: "Help" },
          cause: { en: "Cause" },
          steps: { en: ["Retry"] },
        },
      ],
    }),
  );
  const manager = await create([source]);
  expect(manager.diagnosticHelp().plugins[0]?.entries[0]?.code).toBe("TOY001");
  expect(manager.staticLanguages().languages).toEqual([]);
  expect(manager.state().plugins[0]?.status).toBe("enabled");
  expect(launcher).not.toHaveBeenCalled();
});

it("checks source restrictions before static declaration semantics, including empty services", async () => {
  const source = await developmentToy(root);
  for (const languageServices of [
    [],
    [{ language: "toy", extensions: ["toy"], capabilities: ["analysis"] }],
  ]) {
    await writeFile(
      path.join(source.directory, "kobrixa-plugin.json"),
      JSON.stringify({
        ...toyManifest,
        runtime: { kind: "static", entry: "illegal.js" },
        contributes: { ...toyManifest.contributes, languageServices },
      }),
    );
    const read = await readSource(source, { safeMode: false });
    expect(read.problems.map((problem) => problem.code)).toEqual([
      "PLUGIN_E_LANGUAGE_SERVICE_REQUIRES_BUILTIN",
    ]);
  }
  expect(staticLanguageDeclarationProblems).not.toHaveBeenCalled();
  await writeManifest(source.directory, toyManifest);
  vi.mocked(staticLanguageDeclarationProblems).mockReturnValueOnce([
    "Duplicate static language id.",
  ]);
  expect((await readSource(source, { safeMode: false })).problems[0]?.code).toBe(
    "PLUGIN_E_MANIFEST",
  );
});

it("reads settings first and reads no grammar for persisted or legacy-disabled sources", async () => {
  const source = await developmentToy(root);
  const key = developmentSourceKey(source.directory);
  for (const persisted of [store([key]), store([], ["acme.toy"])]) {
    vi.mocked(open).mockClear();
    vi.mocked(validateStaticLanguageResources).mockClear();
    const manager = await create([source], { store: persisted });
    expect(manager.state().plugins[0]?.status).toBe("disabled");
    expect(manager.staticLanguages().languages).toEqual([]);
    expect(
      vi
        .mocked(open)
        .mock.calls.some(([file]) => String(file).includes(`${path.sep}language${path.sep}`)),
    ).toBe(false);
    expect(validateStaticLanguageResources).not.toHaveBeenCalled();
  }
});

it("never touches third-party folders in safe mode or after corrupt settings", async () => {
  const source = await developmentToy(root);
  for (const options of [
    { safeMode: true },
    {
      store: {
        ...store(),
        load: async () => ({
          disabled: new Set<string>(),
          legacyDisabledIds: new Set<string>(),
          problem: "corrupt",
        }),
      },
    },
  ]) {
    vi.mocked(realpath).mockClear();
    const manager = await create([builtinToy(), source], options);
    expect(realpath).not.toHaveBeenCalled();
    expect(manager.state().safeMode).toBe(true);
    expect(manager.staticLanguages().languages.map((language) => language.pluginId)).toEqual([
      "test.toy",
    ]);
    expect(await manager.setEnabled(developmentSourceKey(source.directory), true)).toMatchObject({
      ok: false,
      code: "PLUGIN_E_SAFE_MODE",
    });
  }
});

it("atomically publishes detached catalogs and complete owners through disable, enable and removal", async () => {
  const a = await developmentToy(root, "a");
  const b = await developmentToy(root, "b");
  const second = structuredClone(toyManifest);
  second.id = "acme.second";
  second.contributes!.languages![0]!.id = "second";
  await writeManifest(b.directory, second);
  const manager = await create([a, b]);
  const first = manager.staticLanguages();
  expect(first.extensionRoutes.toy).toBeNull();
  expect(manager.state().staticLanguageOwners).toHaveLength(2);
  const key = developmentSourceKey(b.directory);
  const events: ReturnType<PluginManager["state"]>[] = [];
  manager.onEvent((event) => {
    if (event.type === "state") events.push(event.state);
  });
  await manager.setEnabled(key, false);
  expect(manager.staticLanguages().extensionRoutes.toy).toBe("toy");
  expect(manager.staticLanguagesRevision).toBeGreaterThan(first.revision);
  expect(events.at(-1)?.staticLanguageOwners.map((owner) => owner.languageId)).toEqual(["toy"]);
  await manager.setEnabled(key, true);
  expect(manager.staticLanguages().extensionRoutes.toy).toBeNull();
  first.languages[0]!.extensions.push("bad");
  manager.state().staticLanguageOwners[0]!.extensions.push("bad");
  expect(
    manager.staticLanguages().languages.some((language) => language.extensions.includes("bad")),
  ).toBe(false);
  await manager.removeSource(key);
  expect(manager.staticLanguages().extensionRoutes.toy).toBe("toy");
});

it("revokes before reload I/O and never restores old resources after a failed reload", async () => {
  const source = await developmentToy(root);
  const manager = await create([source]);
  const key = developmentSourceKey(source.directory);
  const first = manager.staticLanguages();
  const revisions: number[] = [];
  manager.onEvent((event) => {
    if (event.type === "state" && event.state.staticLanguageOwners.length === 0)
      revisions.push(event.state.staticLanguagesRevision);
  });
  await writeFile(path.join(source.directory, "language/configuration.json"), "{");
  await manager.reloadSource(key);
  expect(revisions.some((revision) => revision > first.revision)).toBe(true);
  expect(manager.staticLanguages().languages).toEqual([]);
  expect(manager.state().plugins[0]).toMatchObject({ status: "enabled", running: false });
  expect(manager.state().plugins[0]?.problems).toContainEqual(
    expect.objectContaining({
      code: "PLUGIN_E_STATIC_LANGUAGE",
      detail: { languageId: "toy", resourcePath: "language/configuration.json" },
    }),
  );
  await writeFile(path.join(source.directory, "language/configuration.json"), "{}");
  await manager.reloadSource(key);
  expect(manager.staticLanguages().languages[0]!.generation).toBeGreaterThan(
    first.languages[0]!.generation,
  );
});

it.each([false, true])(
  "uses a fresh generation for explicit retry after failure (disable first: %s)",
  async (disableFirst) => {
    const source = await developmentToy(root);
    const manager = await create([source]);
    const language = manager.staticLanguages().languages[0]!;
    const report = {
      sourceKey: language.sourceKey,
      generation: language.generation,
      languageId: language.id,
      revision: manager.staticLanguagesRevision,
      reason: "monaco" as const,
      detail: "Provider rejected fixture.",
    };
    for (const bad of [
      { ...report, revision: report.revision - 1 },
      { ...report, generation: report.generation + 1 },
      { ...report, sourceKey: "builtin:forged" },
      { ...report, languageId: "foreign" },
    ])
      expect(manager.reportLanguageRegistrationFailure(bad).accepted).toBe(false);
    // Runtime-local consumer double for T4's permanent per-generation quarantine.
    // Real registrar/Monaco integration remains T8-owned.
    const identity = (item: typeof language) =>
      JSON.stringify([item.pluginId, item.sourceKey, item.generation, item.id]);
    const quarantined = new Set([identity(language)]);
    const register = vi.fn();
    const offer = (item: typeof language) => {
      if (quarantined.has(identity(item))) return false;
      register(item);
      return true;
    };
    expect(manager.reportLanguageRegistrationFailure(report).accepted).toBe(true);
    const isolated = manager.staticLanguagesRevision;
    expect(manager.staticLanguages().languages).toEqual([]);
    expect(
      manager.reportLanguageRegistrationFailure({ ...report, revision: isolated }).accepted,
    ).toBe(false);
    expect(offer(language)).toBe(false);
    await Promise.resolve();
    expect(manager.staticLanguagesRevision).toBe(isolated);
    expect(register).not.toHaveBeenCalled();
    const other = await developmentToy(root, "other");
    const manifest = structuredClone(toyManifest);
    manifest.id = "acme.other";
    manifest.contributes!.languages![0]!.id = "other";
    manifest.contributes!.languages![0]!.extensions = ["other"];
    await writeManifest(other.directory, manifest);
    await manager.addSource(other);
    expect(manager.staticLanguages().languages.map((item) => item.id)).toEqual(["other"]);
    expect(
      manager.state().plugins.find((item) => item.sourceKey === language.sourceKey)?.problems,
    ).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
        detail: { languageId: "toy" },
      }),
    );
    if (disableFirst) {
      expect(await manager.setEnabled(language.sourceKey, false)).toMatchObject({ ok: true });
      expect(
        manager.state().plugins.find((item) => item.sourceKey === language.sourceKey)?.status,
      ).toBe("disabled");
    }
    expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({ ok: true });
    const recovered = manager.staticLanguages().languages.find((item) => item.id === language.id)!;
    expect(recovered.generation).toBeGreaterThan(language.generation);
    expect(manager.state().staticLanguageOwners).toContainEqual(
      expect.objectContaining({
        sourceKey: language.sourceKey,
        languageId: language.id,
        generation: recovered.generation,
      }),
    );
    expect(offer(recovered)).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    // Reject the old identity even if the reporter supplies the latest revision.
    expect(
      manager.reportLanguageRegistrationFailure({
        ...report,
        revision: manager.staticLanguagesRevision,
      }).accepted,
    ).toBe(false);
    expect(
      manager
        .staticLanguages()
        .languages.map((item) => item.id)
        .sort(),
    ).toEqual(["other", "toy"]);
    expect(manager.reportLanguageRegistrationFailure(report).accepted).toBe(false);
    const revision = manager.staticLanguagesRevision;
    await manager.setEnabled(language.sourceKey, true);
    expect(manager.staticLanguagesRevision).toBe(revision);
    expect(
      manager.staticLanguages().languages.find((item) => item.id === language.id)?.generation,
    ).toBe(recovered.generation);
  },
);

it("keeps frontend services valid when static registration fails and builtins remain required", async () => {
  const source = builtinToy("test.owner", "toy", ["toy"]);
  const manifest = source.manifest as PluginManifest;
  manifest.contributes!.frontends = [
    {
      language: "toy",
      entryExtensions: ["toy"],
      sourceExtensions: ["toy"],
      ir: { min: 1, max: 1 },
    },
  ];
  manifest.contributes!.languageServices = [
    { language: "toy", extensions: ["toy"], capabilities: ["analysis"] },
  ];
  const manager = await create([source]);
  const before = manager.resolveLanguageService("toy");
  expect(before).toMatchObject({ ok: true });
  const language = manager.staticLanguages().languages[0]!;
  manager.reportLanguageRegistrationFailure({
    sourceKey: language.sourceKey,
    generation: language.generation,
    languageId: "toy",
    revision: manager.staticLanguagesRevision,
    reason: "session-language-ids",
    detail: "Restart window.",
  });
  expect(manager.resolveLanguageService("toy")).toEqual(before);
  expect(manager.state().plugins[0]?.problems[0]?.detail).toMatchObject({
    languageId: "toy",
    limit: "STATIC_LANGUAGE_LIMITS_V1.sessionLanguageIds",
    allowed: 256,
    actual: 257,
  });
  expect(await manager.setEnabled(language.sourceKey, false)).toMatchObject({
    ok: false,
    code: "PLUGIN_E_BUILTIN_REQUIRED",
  });
  expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({ ok: true });
  expect(manager.staticLanguages().languages[0]!.generation).toBeGreaterThan(language.generation);
  // Equality includes the original service epoch; lexical recovery cannot restart analysis.
  expect(manager.resolveLanguageService("toy")).toEqual(before);
  expect(launcher).not.toHaveBeenCalled();
});

it("preserves disabled state and quarantine when the enable save fails", async () => {
  const source = await developmentToy(root);
  const persisted = store();
  const manager = await create([source], { store: persisted });
  const language = manager.staticLanguages().languages[0]!;
  expect(
    manager.reportLanguageRegistrationFailure({
      sourceKey: language.sourceKey,
      generation: language.generation,
      languageId: language.id,
      revision: manager.staticLanguagesRevision,
      reason: "monaco",
      detail: "Rejected fixture.",
    }).accepted,
  ).toBe(true);
  // A failed disable save still takes effect in this session.
  vi.mocked(persisted.save).mockRejectedValueOnce(new Error("disk full"));
  expect(await manager.setEnabled(language.sourceKey, false)).toMatchObject({
    ok: true,
    persisted: false,
  });
  const disabled = manager.state();
  const catalog = manager.staticLanguages();
  vi.mocked(persisted.save).mockRejectedValueOnce(new Error("disk full"));
  expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({
    ok: false,
    code: "PLUGIN_E_STATE_SAVE",
  });
  expect(manager.state()).toEqual(disabled);
  expect(manager.staticLanguages()).toEqual(catalog);
  expect(await manager.setEnabled(language.sourceKey, true)).toMatchObject({ ok: true });
  // Only successful recovery publishes a replacement identity; no extra generation is needed.
  expect(manager.staticLanguages().languages[0]!.generation).toBe(language.generation + 1);
});

it("reload after a registration failure always publishes a fresh generation", async () => {
  const source = await developmentToy(root);
  const manager = await create([source]);
  const language = manager.staticLanguages().languages[0]!;
  const report = {
    sourceKey: language.sourceKey,
    generation: language.generation,
    languageId: language.id,
    revision: manager.staticLanguagesRevision,
    reason: "adapter" as const,
    detail: "Rejected fixture.",
  };
  expect(manager.reportLanguageRegistrationFailure(report).accepted).toBe(true);
  expect(await manager.reloadSource(language.sourceKey)).toMatchObject({ ok: true });
  const recovered = manager.staticLanguages().languages[0]!;
  expect(recovered.generation).toBeGreaterThan(language.generation);
  expect(
    manager.reportLanguageRegistrationFailure({
      ...report,
      revision: manager.staticLanguagesRevision,
    }).accepted,
  ).toBe(false);
  expect(
    manager.reportLanguageRegistrationFailure({
      ...report,
      generation: recovered.generation,
      revision: manager.staticLanguagesRevision,
    }).accepted,
  ).toBe(true);
});

it("keeps static resources on a process crash and withdraws them on an actual disable", async () => {
  const source = await developmentToy(root);
  const manifest = structuredClone(toyManifest);
  manifest.runtime = { kind: "node", entry: "main.js" };
  manifest.contributes!.commands = [{ id: "acme.toy.run", title: "Run" }];
  await writeManifest(source.directory, manifest);
  await writeFile(path.join(source.directory, "main.js"), "");
  const crashing = vi.fn(
    async () =>
      memoryPlugin((peer, { exit }) => {
        peer.handle("initialize", () => ({
          apiVersion: "1.4.0",
          sdk: { name: "fixture", version: "1" },
        }));
        peer.handle("command/execute", () => {
          exit(1);
          return null;
        });
      }).process,
  );
  const manager = await create([source], { launcher: crashing, supervisor: { restartLimit: 1 } });
  const before = manager.staticLanguages();
  await manager.executeCommand("acme.toy.run");
  await vi.waitFor(() => expect(manager.state().plugins[0]?.status).toBe("failed"));
  expect(manager.staticLanguages()).toEqual(before);
  await manager.setEnabled(developmentSourceKey(source.directory), false);
  expect(manager.staticLanguages().languages).toEqual([]);
});

it("keeps the help revision stable through an unchanged lexical retry", async () => {
  const source = await developmentToy(root);
  const manifest = structuredClone(toyManifest);
  manifest.contributes!.diagnosticHelp = { version: 1, path: "help.json" };
  await writeManifest(source.directory, manifest);
  await writeFile(
    path.join(source.directory, "help.json"),
    JSON.stringify({
      entries: [
        {
          code: "TOY001",
          title: { en: "Help" },
          cause: { en: "Cause" },
          steps: { en: ["Retry"] },
        },
      ],
    }),
  );
  const manager = await create([source]);
  const help = manager.diagnosticHelp();
  const staticRevision = manager.staticLanguagesRevision;
  await manager.setEnabled(developmentSourceKey(source.directory), true);
  expect(manager.diagnosticHelp()).toEqual(help);
  expect(manager.staticLanguagesRevision).toBe(staticRevision);
});

it("changes only lexical revision for alias, extension or raw digest changes", async () => {
  const source = builtinToy();
  const manifest = source.manifest as PluginManifest;
  manifest.contributes!.frontends = [
    {
      language: "toy",
      entryExtensions: ["toy"],
      sourceExtensions: ["toy"],
      ir: { min: 1, max: 1 },
    },
  ];
  manifest.contributes!.languageServices = [
    { language: "toy", extensions: ["toy"], capabilities: ["analysis"] },
  ];
  const manager = await create([source]);
  const binding = manager.resolveLanguageService("toy");
  const key = "builtin:test.toy";
  const first = manager.staticLanguagesRevision;
  manifest.contributes!.languages![0]!.aliases = ["Renamed toy"];
  source.resources = {
    ...source.resources,
    "language/tokenizer.json": source.resources["language/tokenizer.json"]! + " ",
  };
  await manager.setEnabled(key, true);
  expect(manager.staticLanguagesRevision).toBeGreaterThan(first);
  expect(manager.resolveLanguageService("toy")).toEqual(binding);
  const after = manager.staticLanguagesRevision;
  await manager.setEnabled(key, true);
  expect(manager.staticLanguagesRevision).toBe(after);
  // A static-only owner's extension can change independently of any service.
  const lexical = await developmentToy(root);
  const staticManifest = structuredClone(toyManifest);
  staticManifest.id = "acme.lexical";
  staticManifest.contributes!.languages![0]!.id = "lexical";
  await writeManifest(lexical.directory, staticManifest);
  await manager.addSource(lexical);
  const previous = manager.staticLanguagesRevision;
  staticManifest.contributes!.languages![0]!.extensions = ["new"];
  await writeManifest(lexical.directory, staticManifest);
  await manager.setEnabled(developmentSourceKey(lexical.directory), true);
  expect(manager.staticLanguagesRevision).toBeGreaterThan(previous);
  expect(manager.staticLanguages().extensionRoutes.new).toBe("lexical");
  expect(manager.resolveLanguageService("toy")).toEqual(binding);
});

it("drops a late resource open after the source deadline and closes its handle", async () => {
  const source = await developmentToy(root);
  const manager = await create([source], { sourceReadTimeoutMs: 200 });
  const actualOpen = vi.mocked(open).getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed = false;
  let blocked = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    if (!blocked && String(args[0]).endsWith(`${path.sep}language${path.sep}tokenizer.json`)) {
      blocked = true;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        closed = true;
      };
      entered();
      await held;
    }
    return handle;
  });
  try {
    const reloading = manager.reloadSource(developmentSourceKey(source.directory));
    await requested;
    await reloading;
    expect(manager.staticLanguages().languages).toEqual([]);
    expect(manager.state().plugins[0]?.status).toBe("enabled");
    const revision = manager.staticLanguagesRevision;
    const validations = vi.mocked(validateStaticLanguageResources).mock.calls.length;
    release();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(manager.staticLanguagesRevision).toBe(revision);
    expect(validateStaticLanguageResources).toHaveBeenCalledTimes(validations);
  } finally {
    release();
    vi.mocked(open).mockImplementation(actualOpen);
  }
});

it("cannot overwrite a report accepted while another catalog pass is awaiting I/O", async () => {
  const source = await developmentToy(root);
  const manager = await create([source]);
  const extra = await developmentToy(root, "extra");
  const manifest = structuredClone(toyManifest);
  manifest.id = "acme.extra";
  manifest.contributes!.languages![0]!.id = "extra";
  manifest.contributes!.languages![0]!.extensions = ["extra"];
  await writeManifest(extra.directory, manifest);
  const blockedPath = path.join(await realpath(extra.directory), "language/tokenizer.json");
  const actualOpen = vi.mocked(open).getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let blocked = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    if (!blocked && String(args[0]) === blockedPath) {
      blocked = true;
      entered();
      await held;
    }
    return actualOpen(...args);
  });
  try {
    const adding = manager.addSource(extra);
    await requested;
    const language = manager.staticLanguages().languages.find((item) => item.id === "toy")!;
    expect(
      manager.reportLanguageRegistrationFailure({
        sourceKey: language.sourceKey,
        generation: language.generation,
        languageId: language.id,
        revision: manager.staticLanguagesRevision,
        reason: "adapter",
        detail: "Rejected fixture.",
      }).accepted,
    ).toBe(true);
    release();
    await adding;
    expect(manager.staticLanguages().languages.map((item) => item.id)).toEqual(["extra"]);
    expect(manager.state().staticLanguageOwners.map((item) => item.languageId)).toEqual(["extra"]);
  } finally {
    release();
    vi.mocked(open).mockImplementation(actualOpen);
  }
});
