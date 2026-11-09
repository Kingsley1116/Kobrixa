import type { LanguageServiceFactory } from "../language/language-provider.js";
import { basicPlusLanguageService } from "../language/basic-plus-service.js";
export const BUILTIN_LANGUAGE_SERVICES: Readonly<Record<string, LanguageServiceFactory>> = {
  "kobrixa.basic-plus:bp": basicPlusLanguageService,
};
