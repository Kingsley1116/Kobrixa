import type { LanguageBinding } from "../../shared/language-services.js";
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

/** T0 deliberately exposes no plugin routes. T4 supplies the ordered resolver. */
export function resolveLexicalLanguage(input: ResolveLexicalLanguageInput): LexicalLanguageRoute {
  return {
    monacoLanguage: "plaintext",
    displayName: "Plain Text",
    kind: "plaintext",
    catalogRevision: input.catalog.revision,
  };
}
