import type { editor } from "monaco-editor";
import type { LanguageBinding } from "../../shared/language-services.js";
import type { LanguageCompanion } from "./language-companion.js";
import type { LexicalLanguageRoute } from "./static-language-routing.js";

export interface ModelLanguageRoute extends LexicalLanguageRoute {
  binding?: LanguageBinding;
  companion?: LanguageCompanion;
}
/** Identity retained by replaceModelRoute; lexical revision never replaces binding epoch. */
export interface AttachedModelLanguageRoute<T> {
  model: T;
  file: string;
  workspaceId: string | undefined;
  route: ModelLanguageRoute;
  dispose(): void;
}

export function sameBinding(
  a: LanguageBinding | undefined,
  b: LanguageBinding | undefined,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.epoch === b.epoch &&
      a.pluginId === b.pluginId &&
      a.sourceKey === b.sourceKey &&
      a.language === b.language)
  );
}
export function sameModelLanguageRoute(a: ModelLanguageRoute, b: ModelLanguageRoute): boolean {
  return (
    a.monacoLanguage === b.monacoLanguage &&
    a.kind === b.kind &&
    a.displayName === b.displayName &&
    a.catalogRevision === b.catalogRevision &&
    a.staticOwner?.pluginId === b.staticOwner?.pluginId &&
    a.staticOwner?.sourceKey === b.staticOwner?.sourceKey &&
    a.staticOwner?.generation === b.staticOwner?.generation &&
    a.staticOwner?.languageId === b.staticOwner?.languageId &&
    sameBinding(a.binding, b.binding) &&
    a.companion === b.companion
  );
}

export function modelLanguageSelector(model: editor.ITextModel, route: ModelLanguageRoute) {
  const scheme = model.uri.scheme;
  if (!/^kobrixa-model-[0-9]+$/.test(scheme)) throw new Error("Expected a host-owned model URI");
  return { language: route.monacoLanguage, scheme };
}
