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

export const CORE_STATIC_LANGUAGE_IDS: readonly string[] = Object.freeze([
  "abap",
  "aes",
  "apex",
  "azcli",
  "bat",
  "bicep",
  "c",
  "cameligo",
  "clojure",
  "coffeescript",
  "cpp",
  "csharp",
  "csp",
  "css",
  "cypher",
  "dart",
  "dockerfile",
  "ecl",
  "elixir",
  "flow9",
  "freemarker2",
  "freemarker2.tag-angle.interpolation-bracket",
  "freemarker2.tag-angle.interpolation-dollar",
  "freemarker2.tag-auto.interpolation-bracket",
  "freemarker2.tag-auto.interpolation-dollar",
  "freemarker2.tag-bracket.interpolation-bracket",
  "freemarker2.tag-bracket.interpolation-dollar",
  "fsharp",
  "go",
  "graphql",
  "handlebars",
  "hcl",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "julia",
  "kotlin",
  "less",
  "lexon",
  "liquid",
  "lua",
  "m3",
  "markdown",
  "mdx",
  "mips",
  "msdax",
  "mysql",
  "objective-c",
  "pascal",
  "pascaligo",
  "perl",
  "pgsql",
  "php",
  "pla",
  "plaintext",
  "postiats",
  "powerquery",
  "powershell",
  "proto",
  "pug",
  "python",
  "qsharp",
  "r",
  "razor",
  "redis",
  "redshift",
  "restructuredtext",
  "ruby",
  "rust",
  "sb",
  "scala",
  "scheme",
  "scss",
  "shell",
  "sol",
  "sparql",
  "sql",
  "st",
  "swift",
  "systemverilog",
  "tcl",
  "twig",
  "typescript",
  "typespec",
  "vb",
  "verilog",
  "wgsl",
  "xml",
  "yaml",
]);
