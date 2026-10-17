import { expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { EditorModels } from "./editor-models.js";
import type {
  StaticLanguageRegistrar,
  StaticModelContext,
  StaticModelRouteHooks,
} from "./static-language-registration.js";

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
