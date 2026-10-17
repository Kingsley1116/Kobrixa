import { expect, expectTypeOf, it, vi } from "vitest";
import {
  PluginManager,
  emptyStaticLanguagesCatalog,
  type PluginProblem,
  type PluginSource,
  type PluginsSnapshot,
  type StaticLanguagesCatalog,
  type StaticLanguageOwner,
  type ReportLanguageRegistrationFailureInput,
  type ReportLanguageRegistrationFailureResult,
} from "./index.js";

it("provides detached empty catalogs and mandatory owner snapshot fields without launching", async () => {
  expectTypeOf<PluginManager["staticLanguages"]>().toEqualTypeOf<() => StaticLanguagesCatalog>();
  expectTypeOf<PluginManager["staticLanguagesRevision"]>().toEqualTypeOf<number>();
  expectTypeOf<PluginsSnapshot["staticLanguageOwners"]>().toEqualTypeOf<StaticLanguageOwner[]>();
  expectTypeOf<PluginManager["reportLanguageRegistrationFailure"]>().toEqualTypeOf<
    (input: ReportLanguageRegistrationFailureInput) => ReportLanguageRegistrationFailureResult
  >();
  const source: PluginSource = { kind: "builtin", manifest: {}, resources: {} };
  expect(source.resources).toEqual({});
  const problem: PluginProblem = {
    code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
    message: "acme.toy could not register toy.",
    detail: { languageId: "toy", allowed: 256, actual: 257 },
  };
  expect(problem.detail?.languageId).toBe("toy");
  const launcher = vi.fn();
  const manager = await PluginManager.create({
    sources: [],
    safeMode: false,
    locale: "en",
    launcher,
    store: {
      load: async () => ({ disabled: new Set<string>(), legacyDisabledIds: new Set<string>() }),
      save: async () => {},
    },
  });
  expect(manager.staticLanguages()).toEqual(
    emptyStaticLanguagesCatalog(manager.staticLanguagesRevision),
  );
  expect(manager.state().staticLanguagesRevision).toBe(manager.staticLanguagesRevision);
  expect(manager.state().staticLanguageOwners).toEqual([]);
  const first = manager.staticLanguages();
  first.extensionRoutes.toy = "toy";
  expect(manager.staticLanguages().extensionRoutes).toEqual({});
  expect(launcher).not.toHaveBeenCalled();
  await manager.shutdown();
});
