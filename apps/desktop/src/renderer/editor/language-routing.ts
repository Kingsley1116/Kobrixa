import { bindingKey, supportsFile, type LanguageStatus } from "../../shared/language-services.js";
import type { LanguageCompanion } from "./language-companion.js";
import { BUILTIN_LANGUAGE_COMPANIONS } from "./builtin-language-companions.js";
import { resolveLexicalLanguage, type LexicalLanguageRoute } from "./static-language-routing.js";
import {
  sameModelLanguageRoute,
  type AttachedModelLanguageRoute,
  type ModelLanguageRoute,
} from "./model-language-route.js";
export type { ModelLanguageRoute } from "./model-language-route.js";

export function routeLanguage(
  file: string,
  status: LanguageStatus | undefined,
  companions: Readonly<Record<string, LanguageCompanion>> = BUILTIN_LANGUAGE_COMPANIONS,
  lexical?: LexicalLanguageRoute,
): ModelLanguageRoute {
  const binding =
    status?.availability.kind === "available" && supportsFile(status.availability.binding, file)
      ? status.availability.binding
      : undefined;
  const route =
    lexical ??
    resolveLexicalLanguage({
      file,
      ...(binding ? { binding } : {}),
      activeOwners: [],
      coreExtensionRoutes: { json: "json" },
      catalog: {
        formatVersion: 1,
        limitsVersion: 1,
        revision: 0,
        languages: [],
        extensionRoutes: {},
        conflicts: [],
      },
    });
  if (route.kind === "core" || !binding) return route;
  const key = bindingKey(binding);
  const companion = Object.hasOwn(companions, key) ? companions[key] : undefined;
  return { ...route, binding, ...(companion ? { companion } : {}) };
}

export function replaceModelRoute<T>(
  previous: AttachedModelLanguageRoute<T> | undefined,
  model: T,
  file: string,
  workspaceId: string | undefined,
  route: ModelLanguageRoute,
  attach: (model: T, route: ModelLanguageRoute) => { dispose(): void },
): AttachedModelLanguageRoute<T> {
  if (
    previous?.model === model &&
    previous.file === file &&
    previous.workspaceId === workspaceId &&
    sameModelLanguageRoute(previous.route, route)
  )
    return previous;
  previous?.dispose();
  const handle = route.binding ? attach(model, route) : undefined;
  let disposed = false;
  return {
    model,
    file,
    workspaceId,
    route,
    dispose() {
      if (disposed) return;
      disposed = true;
      handle?.dispose();
    },
  };
}
