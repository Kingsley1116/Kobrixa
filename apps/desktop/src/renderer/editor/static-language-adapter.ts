import { languages } from "monaco-editor";
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  validateStaticLanguageResources,
  type Action,
  type Pair,
  type RegexData,
  type TokenAction,
} from "@kobrixa/plugin-protocol";
import type { ValidatedStaticLanguage } from "../../shared/static-languages.js";

export interface MonacoStaticLanguageDefinition {
  tokenizer: languages.IMonarchLanguage;
  configuration: languages.LanguageConfiguration;
}
export class StaticLanguageAdapterError extends Error {
  constructor(
    readonly reason: "validation" | "adapter",
    message: string,
  ) {
    super(message);
    this.name = "StaticLanguageAdapterError";
  }
}
const pair = (value: Pair): languages.CharacterPair => [value.open, value.close];
const regex = (value: RegexData): RegExp => new RegExp(value.pattern, value.flags);
function token(value: TokenAction): languages.IExpandedMonarchLanguageAction {
  const result: languages.IExpandedMonarchLanguageAction = { token: value.token };
  if (value.next !== undefined) result.next = value.next;
  if (value.bracket !== undefined) result.bracket = value.bracket;
  return result;
}
function action(value: Action): languages.IMonarchLanguageAction {
  if ("token" in value) return token(value);
  const cases: Record<string, languages.IMonarchLanguageAction> = {};
  for (const branch of value.cases) {
    const key =
      branch.when === "@default" || branch.when === "@eos"
        ? branch.when
        : `@list_${branch.when.slice(1)}`;
    cases[key] = token(branch.action);
  }
  return { cases };
}

export function adaptStaticLanguage(
  language: ValidatedStaticLanguage,
): MonacoStaticLanguageDefinition {
  const validated = validateStaticLanguageResources({
    languageId: language.id,
    formatVersion: STATIC_LANGUAGE_FORMAT_VERSION,
    limitsVersion: STATIC_LANGUAGE_FORMAT_VERSION,
    tokenizer: language.tokenizer,
    configuration: language.configuration,
    resourceBytes: language.resourceBytes,
  });
  if (!validated.ok)
    throw new StaticLanguageAdapterError(
      "validation",
      validated.problems.map((problem) => problem.message).join("; "),
    );
  if (
    validated.expandedRules !== language.expandedRules ||
    validated.resourceBytes.tokenizer !== language.resourceBytes.tokenizer ||
    validated.resourceBytes.configuration !== language.resourceBytes.configuration
  ) {
    throw new StaticLanguageAdapterError("validation", "Resource accounting mismatch");
  }
  try {
    const source = validated.tokenizer;
    const tokenizer: languages.IMonarchLanguage = {
      start: "root",
      ignoreCase: source.ignoreCase,
      defaultToken: source.defaultToken ?? "",
      tokenPostfix: source.tokenPostfix ?? `.${language.id}`,
      tokenizer: {},
    };
    for (const list of source.lists ?? []) tokenizer[`list_${list.name}`] = [...list.words];
    if (source.brackets)
      tokenizer.brackets = source.brackets.map((value) => ({
        open: value.open,
        close: value.close,
        token: value.token,
      }));
    for (const state of source.states) {
      tokenizer.tokenizer[state.name] = state.rules.map((rule) => {
        if ("include" in rule) return { include: rule.include };
        return {
          // Match the validator's order: native .source, @ escaping, then
          // Monarch strips ^ and adds ^(?:...) (checked there against 4,096).
          regex: new RegExp(regex(rule.regex).source.replaceAll("@", "@@"), rule.regex.flags),
          action: action(rule.action),
        };
      });
    }
    const sourceConfig = validated.configuration;
    const configuration: languages.LanguageConfiguration = {};
    if (sourceConfig.comments) {
      configuration.comments = {};
      if (sourceConfig.comments.lineComment !== undefined)
        configuration.comments.lineComment = sourceConfig.comments.lineComment;
      if (sourceConfig.comments.blockComment)
        configuration.comments.blockComment = pair(sourceConfig.comments.blockComment);
    }
    if (sourceConfig.brackets) configuration.brackets = sourceConfig.brackets.map(pair);
    if (sourceConfig.autoClosingPairs)
      configuration.autoClosingPairs = sourceConfig.autoClosingPairs.map((value) => ({
        open: value.open,
        close: value.close,
        ...(value.notIn ? { notIn: [...value.notIn] } : {}),
      }));
    if (sourceConfig.surroundingPairs)
      configuration.surroundingPairs = sourceConfig.surroundingPairs.map((value) => ({
        open: value.open,
        close: value.close,
      }));
    if (sourceConfig.indentationRules) {
      const rules = sourceConfig.indentationRules;
      configuration.indentationRules = {
        increaseIndentPattern: regex(rules.increaseIndentPattern),
        decreaseIndentPattern: regex(rules.decreaseIndentPattern),
      };
      if (rules.indentNextLinePattern)
        configuration.indentationRules.indentNextLinePattern = regex(rules.indentNextLinePattern);
      if (rules.unIndentedLinePattern)
        configuration.indentationRules.unIndentedLinePattern = regex(rules.unIndentedLinePattern);
    }
    if (sourceConfig.wordPattern) configuration.wordPattern = regex(sourceConfig.wordPattern);
    const indentActions = {
      none: languages.IndentAction.None,
      indent: languages.IndentAction.Indent,
      indentOutdent: languages.IndentAction.IndentOutdent,
      outdent: languages.IndentAction.Outdent,
    } as const;
    if (sourceConfig.onEnterRules)
      configuration.onEnterRules = sourceConfig.onEnterRules.map((rule) => {
        const result: languages.OnEnterRule = {
          beforeText: regex(rule.beforeText),
          action: { indentAction: indentActions[rule.action.indentAction] },
        };
        if (rule.afterText) result.afterText = regex(rule.afterText);
        if (rule.previousLineText) result.previousLineText = regex(rule.previousLineText);
        if (rule.action.appendText !== undefined) result.action.appendText = rule.action.appendText;
        if (rule.action.removeText !== undefined) result.action.removeText = rule.action.removeText;
        return result;
      });
    return { tokenizer, configuration };
  } catch {
    throw new StaticLanguageAdapterError("adapter", "Could not construct Monaco language objects");
  }
}
