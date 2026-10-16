import {
  bindingKey,
  supportsFile,
  type LanguageBinding,
  type LanguageStatus,
} from "../../shared/language-services.js";
import type { LanguageCompanion } from "./language-companion.js";
import { BUILTIN_LANGUAGE_COMPANIONS } from "./builtin-language-companions.js";
export interface ModelLanguageRoute {
  monacoLanguage: string;
  binding?: LanguageBinding;
  companion?: LanguageCompanion;
}
export function routeLanguage(
  file: string,
  status: LanguageStatus | undefined,
  companions: Readonly<Record<string, LanguageCompanion>> = BUILTIN_LANGUAGE_COMPANIONS,
): ModelLanguageRoute {
  const lexical = /\.json$/i.test(file)
    ? "json"
    : /\.(bp|bpi|bpm)$/i.test(file)
      ? "basic-plus"
      : "plaintext";
  if (lexical === "json" || status?.availability.kind !== "available")
    return { monacoLanguage: lexical };
  const binding = status.availability.binding;
  if (!supportsFile(binding, file)) return { monacoLanguage: lexical };
  const companion = companions[bindingKey(binding)];
  return {
    monacoLanguage: companion?.monacoLanguage ?? lexical,
    binding,
    ...(companion ? { companion } : {}),
  };
}
interface AttachedRoute<T> {
  model: T;
  file: string;
  epoch: number | undefined;
  dispose(): void;
}
export function replaceModelRoute<T>(
  previous: AttachedRoute<T> | undefined,
  model: T,
  file: string,
  status: LanguageStatus | undefined,
  attach: (model: T, route: ModelLanguageRoute) => { dispose(): void },
): AttachedRoute<T> {
  const route = routeLanguage(file, status);
  if (
    previous?.model === model &&
    previous.file === file &&
    previous.epoch === route.binding?.epoch
  )
    return previous;
  previous?.dispose();
  const attached = route.binding ? attach(model, route) : undefined;
  return { model, file, epoch: route.binding?.epoch, dispose: () => attached?.dispose() };
}
