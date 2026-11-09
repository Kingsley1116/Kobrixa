import type { LanguageCompanion } from "./language-companion.js";
import { basicPlusCompanion } from "./companions/basic-plus/companion.js";
export const BUILTIN_LANGUAGE_COMPANIONS: Readonly<Record<string, LanguageCompanion>> = {
  "kobrixa.basic-plus:bp": basicPlusCompanion,
};
