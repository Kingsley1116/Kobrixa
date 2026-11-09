import { expect, expectTypeOf, it } from "vitest";
import type { PluginsApi, PluginEvent } from "./plugins.js";
import type {
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
  ReportLanguageRegistrationFailureResult,
} from "./static-languages.js";
import type { SessionMarker, SessionMarkerFile } from "../main/plugins/session.js";
import type {
  StaticLanguageStore,
  StaticLanguageStoreApi,
  createStaticLanguageStore,
} from "../renderer/editor/static-language-store.js";
import type {
  StaticLanguageRegistrar,
  CreateStaticLanguageRegistrarInput,
  createStaticLanguageRegistrar,
} from "../renderer/editor/static-language-registration.js";
import type {
  LexicalLanguageRoute,
  ResolveLexicalLanguageInput,
  resolveLexicalLanguage,
} from "../renderer/editor/static-language-routing.js";
import type {
  StaticLanguageBootstrapInput,
  StaticLanguageBootstrapResult,
  bootstrapStaticLanguages,
} from "../renderer/editor/static-language-bootstrap.js";
import type { EditorThemeApi, initializeEditorThemes } from "../renderer/editor/editor-theme.js";
import type { ModelLanguageRoute } from "../renderer/editor/model-language-route.js";

it("uses the same DTO and exact signatures across preload, bootstrap and renderer", () => {
  expectTypeOf<PluginsApi["staticLanguages"]>().toEqualTypeOf<
    () => Promise<StaticLanguagesCatalog>
  >();
  expectTypeOf<PluginsApi["reportLanguageRegistrationFailure"]>().toEqualTypeOf<
    (
      input: ReportLanguageRegistrationFailureInput,
    ) => Promise<ReportLanguageRegistrationFailureResult>
  >();
  expectTypeOf<
    Extract<PluginEvent, { type: "state" }>["state"]["staticLanguagesRevision"]
  >().toEqualTypeOf<number>();
  expectTypeOf<SessionMarker["thirdPartyStaticContributions"]>().toEqualTypeOf<boolean>();
  expectTypeOf<SessionMarkerFile["markThirdPartyStaticContributions"]>().toEqualTypeOf<
    () => void
  >();
  expectTypeOf<typeof createStaticLanguageStore>().toEqualTypeOf<
    (api: StaticLanguageStoreApi) => StaticLanguageStore
  >();
  expectTypeOf<typeof createStaticLanguageRegistrar>().toEqualTypeOf<
    (input: CreateStaticLanguageRegistrarInput) => StaticLanguageRegistrar
  >();
  expectTypeOf<typeof resolveLexicalLanguage>().toEqualTypeOf<
    (input: ResolveLexicalLanguageInput) => LexicalLanguageRoute
  >();
  expectTypeOf<typeof bootstrapStaticLanguages>().toEqualTypeOf<
    (input: StaticLanguageBootstrapInput) => Promise<StaticLanguageBootstrapResult>
  >();
  expectTypeOf<typeof initializeEditorThemes>().toEqualTypeOf<(api: EditorThemeApi) => void>();
  expectTypeOf<ModelLanguageRoute>().toExtend<LexicalLanguageRoute>();
  expect(true).toBe(true);
});
