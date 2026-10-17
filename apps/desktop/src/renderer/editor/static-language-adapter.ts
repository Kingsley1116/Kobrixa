import type { languages } from "monaco-editor";
import type { ValidatedStaticLanguage } from "../../shared/static-languages.js";

export interface MonacoStaticLanguageDefinition {
  tokenizer: languages.IMonarchLanguage;
  configuration: languages.LanguageConfiguration;
}
/** T4 validates the DTO and translates only allowlisted fields. */
export function adaptStaticLanguage(
  language: ValidatedStaticLanguage,
): MonacoStaticLanguageDefinition {
  void language;
  throw new Error("not implemented");
}
