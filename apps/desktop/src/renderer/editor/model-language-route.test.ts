import { expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { EditorModels } from "./editor-models.js";
import { modelLanguageSelector, type ModelLanguageRoute } from "./model-language-route.js";
import type {
  StaticLanguageRegistrar,
  StaticModelContext,
  StaticModelRouteHooks,
} from "./static-language-registration.js";

it.each(["bp", "plaintext"])(
  "isolates %s providers with Monaco's selector matcher while preserving file paths",
  async (language) => {
    // Exercise the pinned matcher in Node; query/authority do not isolate providers.
    const selectorPath = "monaco-editor/editor/common/languageSelector.js";
    const uriPath = "monaco-editor/base/common/uri.js";
    const { score } = await import(selectorPath);
    const { URI } = await import(uriPath);
    const uri = URI.from({ scheme: "kobrixa-model-1", path: "/dir/[second]*.bp" });
    const model = { uri } as editor.ITextModel;
    const route: ModelLanguageRoute = {
      monacoLanguage: language,
      kind: language === "plaintext" ? "plaintext" : "static",
      displayName: language,
      catalogRevision: 1,
    };
    const selector = modelLanguageSelector(model, route);
    expect(uri.path).toBe("/dir/[second]*.bp");
    expect(score(selector, uri, language, true)).toBe(10);
    expect(score(selector, uri, "json", true)).toBe(0);
    for (const scheme of ["kobrixa-model-2", "kobrixa-review", "kobrixa-format", "file"])
      expect(score(selector, uri.with({ scheme }), language, true)).toBe(0);
    expect(() =>
      modelLanguageSelector(
        { uri: uri.with({ scheme: "kobrixa-review" }) } as editor.ITextModel,
        route,
      ),
    ).toThrow("Expected a host-owned model URI");
  },
);

it("keeps a hidden model context through rename and releases it only when the model closes", () => {
  const model = { uri: { path: "/old.toy" }, dispose: vi.fn() } as unknown as editor.ITextModel;
  let context!: () => StaticModelContext;
  let hooks!: StaticModelRouteHooks;
  const release = vi.fn();
  const registrar = {
    refreshModels: vi.fn(),
    trackModel: vi.fn(
      (
        _m: editor.ITextModel,
        getter: () => StaticModelContext,
        suppliedHooks?: StaticModelRouteHooks,
      ) => {
        context = getter;
        hooks = suppliedHooks!;
        return { dispose: release };
      },
    ),
  } as unknown as StaticLanguageRegistrar;
  const models = new EditorModels();
  models.models.set("old.toy", model);
  models.configureLanguages(registrar, "workspace-a", undefined);
  const beforeChange = vi.fn();
  models.trackLanguage(model, { beforeChange, afterChange() {} });
  models.trackLanguage(model, { beforeChange, afterChange() {} });
  expect(registrar.trackModel).toHaveBeenCalledOnce();
  models.releaseLanguageHooks();
  models.models.delete("old.toy");
  models.models.set("new.txt", model);
  expect(context()).toEqual({ file: "new.txt", workspaceId: "workspace-a" });
  hooks.beforeChange(undefined, {
    kind: "plaintext",
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    catalogRevision: 2,
  });
  expect(beforeChange).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  models.dispose();
  expect(release).toHaveBeenCalledOnce();
  expect(model.dispose).toHaveBeenCalledOnce();
});
