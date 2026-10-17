import { CORE_LANGUAGE_IDS } from "./core-language-routes.js";
import { supportsFile, type LanguageBinding } from "../../shared/language-services.js";
import type { StaticLanguageOwner, StaticLanguagesCatalog } from "../../shared/static-languages.js";

export type StaticRouteOwner = Pick<
  StaticLanguageOwner,
  "pluginId" | "sourceKey" | "generation" | "languageId"
>;
export interface LexicalLanguageRoute {
  monacoLanguage: string;
  displayName: string;
  kind: "core" | "static" | "plaintext";
  catalogRevision: number;
  staticOwner?: StaticRouteOwner;
}
export interface ResolveLexicalLanguageInput {
  file: string;
  binding?: LanguageBinding;
  catalog: StaticLanguagesCatalog;
  /** Only fully installed, non-quarantined owners may supply a route. */
  activeOwners: readonly StaticLanguageOwner[];
  /** Lowercase last extensions without dots; host-owned, e.g. { json: "json" }. */
  coreExtensionRoutes: Readonly<Record<string, string>>;
}

export function resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute {
  const { catalog, binding, activeOwners, coreExtensionRoutes } = input;
  const name = input.file.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  const plain = (): LexicalLanguageRoute => ({
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    kind: "plaintext",
    catalogRevision: catalog.revision,
  });
  if (Object.hasOwn(coreExtensionRoutes, extension)) {
    const id = coreExtensionRoutes[extension];
    if (id && CORE_LANGUAGE_IDS.has(id))
      return {
        monacoLanguage: id,
        displayName: id === "json" ? "JSON" : id,
        kind: "core",
        catalogRevision: catalog.revision,
      };
  }
  const applicable = binding && supportsFile(binding, input.file);
  const globalId = Object.hasOwn(catalog.extensionRoutes, extension)
    ? catalog.extensionRoutes[extension]
    : undefined;
  const language = catalog.languages.find(
    (candidate) =>
      candidate.extensions.includes(extension) &&
      (applicable
        ? candidate.id === binding.language &&
          candidate.pluginId === binding.pluginId &&
          candidate.sourceKey === binding.sourceKey
        : candidate.id === globalId) &&
      activeOwners.some(
        (owner) =>
          owner.languageId === candidate.id &&
          owner.pluginId === candidate.pluginId &&
          owner.sourceKey === candidate.sourceKey &&
          owner.generation === candidate.generation &&
          owner.extensions.includes(extension),
      ),
  );
  if (!language) return plain();
  return {
    monacoLanguage: language.id,
    displayName: language.aliases[0] ?? language.id,
    kind: "static",
    catalogRevision: catalog.revision,
    staticOwner: {
      pluginId: language.pluginId,
      sourceKey: language.sourceKey,
      generation: language.generation,
      languageId: language.id,
    },
  };
}
