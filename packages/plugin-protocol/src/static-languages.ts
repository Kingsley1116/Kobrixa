export type RegexData = { pattern: string; flags: "" | "i" };
export type Pair = { open: string; close: string };
export type TokenAction = {
  token: string;
  next?: string;
  bracket?: "@open" | "@close";
};
export type Action = TokenAction | { cases: { when: string; action: TokenAction }[] };
export type Rule = { regex: RegexData; action: Action } | { include: string };
export type StaticLanguageTokenizerV1 = {
  ignoreCase: boolean;
  defaultToken?: string;
  tokenPostfix?: string;
  lists?: { name: string; words: string[] }[];
  brackets?: (Pair & { token: string })[];
  states: { name: string; rules: Rule[] }[];
};
export type StaticLanguageConfigurationV1 = {
  comments?: { lineComment?: string; blockComment?: Pair };
  brackets?: Pair[];
  autoClosingPairs?: (Pair & { notIn?: ("string" | "comment" | "regex")[] })[];
  surroundingPairs?: Pair[];
  indentationRules?: {
    increaseIndentPattern: RegexData;
    decreaseIndentPattern: RegexData;
    indentNextLinePattern?: RegexData;
    unIndentedLinePattern?: RegexData;
  };
  onEnterRules?: {
    beforeText: RegexData;
    afterText?: RegexData;
    previousLineText?: RegexData;
    action: {
      indentAction: "none" | "indent" | "indentOutdent" | "outdent";
      appendText?: string;
      removeText?: number;
    };
  }[];
  wordPattern?: RegexData;
};
export type StaticLanguageResourceBytes = { tokenizer: number; configuration: number };
export type StaticLanguageResourceProblemDetail = {
  languageId: string;
  resourcePath?: string;
  fieldPath?: string;
  limit?: string;
  allowed?: number | readonly string[];
  actual?: number | string;
};
export type StaticLanguageValidationProblem = {
  message: string;
  detail: StaticLanguageResourceProblemDetail;
};
export type ValidateStaticLanguageResourcesInput = {
  languageId: string;
  formatVersion: number;
  limitsVersion: number;
  tokenizer: unknown;
  configuration: unknown;
  /** Original UTF-8 byte counts, including any BOM; never stringify-derived. */
  resourceBytes: StaticLanguageResourceBytes;
  /** Main supplies relative manifest paths. Renderer DTOs omit them. */
  resourcePaths?: { tokenizer: string; configuration: string };
};
export type StaticLanguageValidationResult =
  | {
      ok: true;
      tokenizer: StaticLanguageTokenizerV1;
      configuration: StaticLanguageConfigurationV1;
      resourceBytes: StaticLanguageResourceBytes;
      expandedRules: number;
      rules: number;
      regexes: number;
    }
  | { ok: false; problems: StaticLanguageValidationProblem[] };

/** T0 contract stub. T1 supplies strict schemas and the pure AST/reference validator. */
export function validateStaticLanguageResources(
  input: ValidateStaticLanguageResourcesInput,
): StaticLanguageValidationResult {
  void input;
  throw new Error("not implemented");
}
