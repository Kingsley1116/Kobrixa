import type { LanguageBinding } from "../../shared/language-services.js";
import type { LanguageCompanion } from "./language-companion.js";
import type { LexicalLanguageRoute } from "./static-language-routing.js";

/** T5 makes language-routing.ts re-export this type when migrating its existing consumers. */
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
