import type {
  StaticLanguageConfigurationV1,
  StaticLanguageResourceBytes,
  StaticLanguageResourceProblemDetail,
  StaticLanguageTokenizerV1,
} from "@kobrixa/plugin-protocol";

export type StaticLanguageSourceIdentity = {
  pluginId: string;
  sourceKey: string;
  languageId: string;
};
export type StaticLanguageProblemDetail = StaticLanguageResourceProblemDetail & {
  conflictingSources?: StaticLanguageSourceIdentity[];
};
export type StaticLanguageOwner = StaticLanguageSourceIdentity & {
  generation: number;
  extensions: string[];
};
export type ValidatedStaticLanguage = {
  sourceKey: string;
  pluginId: string;
  generation: number;
  id: string;
  extensions: string[];
  aliases: string[];
  resourceDigest: string;
  tokenizer: StaticLanguageTokenizerV1;
  configuration: StaticLanguageConfigurationV1;
  resourceBytes: StaticLanguageResourceBytes;
  expandedRules: number;
};
export type StaticLanguageConflict = {
  kind: "reserved-id" | "reserved-extension" | "frontend-owner" | "id" | "extension";
  key: string;
  sources: StaticLanguageSourceIdentity[];
};
export type StaticLanguagesCatalog = {
  formatVersion: 1;
  limitsVersion: 1;
  revision: number;
  languages: ValidatedStaticLanguage[];
  extensionRoutes: Record<string, string | null>;
  conflicts: StaticLanguageConflict[];
};
export type StaticLanguageRegistrationFailureReason =
  "dto-version" | "validation" | "adapter" | "monaco" | "session-language-ids";
export type ReportLanguageRegistrationFailureInput = {
  sourceKey: string;
  generation: number;
  languageId: string;
  revision: number;
  reason: StaticLanguageRegistrationFailureReason;
  /** At most 2,048 Unicode code points; no physical paths. */
  detail: string;
};
export type ReportLanguageRegistrationFailureResult = {
  accepted: boolean;
  revision: number;
};

export function emptyStaticLanguagesCatalog(revision = 0): StaticLanguagesCatalog {
  return {
    formatVersion: 1,
    limitsVersion: 1,
    revision,
    languages: [],
    extensionRoutes: {},
    conflicts: [],
  };
}
