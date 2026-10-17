import type { z } from "zod";
import { compilerIdSchema } from "./manifest.js";
import {
  STATIC_LANGUAGE_FORMAT_VERSION,
  STATIC_LANGUAGE_LIMITS_V1 as L,
} from "./static-language-limits.js";
import { inspectStaticLanguageGraph } from "./static-language-graph.js";
import { checkStaticRegex } from "./static-language-regex.js";
import {
  staticLanguageTokenizerV1Schema,
  staticLanguageConfigurationV1Schema,
  type RegexData,
  type TokenAction,
  type StaticLanguageTokenizerV1,
  type StaticLanguageConfigurationV1,
} from "./static-language-schemas.js";

export {
  staticLanguageTokenizerV1Schema,
  staticLanguageConfigurationV1Schema,
} from "./static-language-schemas.js";
export type {
  RegexData,
  Pair,
  TokenAction,
  Action,
  Rule,
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "./static-language-schemas.js";
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

type Resource = "tokenizer" | "configuration";
type Detail = Omit<StaticLanguageResourceProblemDetail, "languageId" | "resourcePath">;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const pathText = (path: readonly PropertyKey[]) =>
  path.reduce<string>(
    (text, part) =>
      typeof part === "number" ? `${text}[${part}]` : `${text}${text ? "." : ""}${String(part)}`,
    "",
  );

export function validateStaticLanguageResources(
  input: ValidateStaticLanguageResourcesInput,
): StaticLanguageValidationResult {
  const fail = (
    resource: Resource,
    message: string,
    detail: Detail = {},
  ): StaticLanguageValidationResult => {
    const resourcePath = input.resourcePaths?.[resource];
    return {
      ok: false,
      problems: [
        {
          message: `${input.languageId} / ${resourcePath ?? resource} / ${detail.fieldPath ?? "$"}: ${message}`,
          detail: {
            languageId: input.languageId,
            ...(resourcePath === undefined ? {} : { resourcePath }),
            ...detail,
          },
        },
      ],
    };
  };
  const limit = (resource: Resource, name: keyof typeof L, actual: number, fieldPath: string) =>
    fail(resource, `STATIC_LANGUAGE_LIMITS_V1.${name} exceeded.`, {
      fieldPath,
      limit: `STATIC_LANGUAGE_LIMITS_V1.${name}`,
      allowed: L[name],
      actual,
    });
  if (!compilerIdSchema.safeParse(input.languageId).success)
    return fail("tokenizer", "Invalid language id.", { fieldPath: "languageId" });
  for (const field of ["formatVersion", "limitsVersion"] as const)
    if (input[field] !== STATIC_LANGUAGE_FORMAT_VERSION)
      return fail("tokenizer", "Unsupported static language version.", {
        fieldPath: field,
        allowed: STATIC_LANGUAGE_FORMAT_VERSION,
        actual: input[field],
      });
  for (const resource of ["tokenizer", "configuration"] as const) {
    const bytes = input.resourceBytes[resource];
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      return fail(resource, "Original byte count must be a nonnegative safe integer.", {
        fieldPath: `resourceBytes.${resource}`,
      });
    if (bytes > L.resourceFileBytes)
      return limit(resource, "resourceFileBytes", bytes, `resourceBytes.${resource}`);
  }
  const totalBytes = input.resourceBytes.tokenizer + input.resourceBytes.configuration;
  if (totalBytes > L.resourceBytesPerLanguage)
    return limit("tokenizer", "resourceBytesPerLanguage", totalBytes, "resourceBytes");

  const structuralFailure = (
    resource: Resource,
    error: z.ZodError,
  ): StaticLanguageValidationResult => {
    let issue = error.issues[0]!;
    while (issue.code === "invalid_union" && issue.errors[0]?.[0]) issue = issue.errors[0][0];
    const fieldPath = pathText(issue.path);
    let value: unknown = input[resource];
    for (const key of issue.path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
        value = undefined;
        break;
      }
      value = (value as Record<PropertyKey, unknown>)[key];
    }
    const names: Record<string, keyof typeof L> = {
      pattern: "patternLength",
      states: "statesPerLanguage",
      rules: "rulesPerLanguage",
      lists: "listsPerLanguage",
      words: "wordsPerLanguage",
      cases: "casesPerRule",
      onEnterRules: "onEnterRules",
    };
    const key = String(issue.path.at(-1));
    const name = Object.hasOwn(names, key) ? names[key] : undefined;
    if (issue.code === "too_big" || issue.code === "too_small") {
      const allowed = Number(issue.code === "too_big" ? issue.maximum : issue.minimum);
      const actual =
        typeof value === "string"
          ? [...value].length
          : Array.isArray(value)
            ? value.length
            : typeof value === "number"
              ? value
              : 0;
      return fail(resource, issue.message, {
        fieldPath,
        limit: name ? `STATIC_LANGUAGE_LIMITS_V1.${name}` : `static-language-v1.${fieldPath}`,
        allowed,
        actual,
      });
    }
    if (key === "flags" && typeof value === "string")
      return fail(resource, issue.message, {
        fieldPath,
        limit: "STATIC_LANGUAGE_LIMITS_V1.regexFlags",
        allowed: L.regexFlags,
        actual: value,
      });
    return fail(resource, issue.message, { fieldPath });
  };
  const parsedTokenizer = staticLanguageTokenizerV1Schema.safeParse(input.tokenizer);
  if (!parsedTokenizer.success) return structuralFailure("tokenizer", parsedTokenizer.error);
  const parsedConfiguration = staticLanguageConfigurationV1Schema.safeParse(input.configuration);
  if (!parsedConfiguration.success)
    return structuralFailure("configuration", parsedConfiguration.error);
  const tokenizer = parsedTokenizer.data;
  const configuration = parsedConfiguration.data;
  const rules = tokenizer.states.reduce((total, state) => total + state.rules.length, 0);
  if (rules > L.rulesPerLanguage) return limit("tokenizer", "rulesPerLanguage", rules, "states");
  const words = (tokenizer.lists ?? []).reduce((total, list) => total + list.words.length, 0);
  if (words > L.wordsPerLanguage) return limit("tokenizer", "wordsPerLanguage", words, "lists");

  const regexes: { data: RegexData; resource: Resource; fieldPath: string }[] = [];
  for (const [i, state] of tokenizer.states.entries())
    for (const [j, rule] of state.rules.entries())
      if ("regex" in rule)
        regexes.push({
          data: rule.regex,
          resource: "tokenizer",
          fieldPath: `states[${i}].rules[${j}].regex`,
        });
  for (const [key, data] of Object.entries(configuration.indentationRules ?? {}))
    if (data)
      regexes.push({ data, resource: "configuration", fieldPath: `indentationRules.${key}` });
  for (const [i, rule] of (configuration.onEnterRules ?? []).entries())
    for (const key of ["beforeText", "afterText", "previousLineText"] as const)
      if (rule[key])
        regexes.push({
          data: rule[key],
          resource: "configuration",
          fieldPath: `onEnterRules[${i}].${key}`,
        });
  if (configuration.wordPattern)
    regexes.push({
      data: configuration.wordPattern,
      resource: "configuration",
      fieldPath: "wordPattern",
    });
  if (regexes.length > L.regexesPerLanguage)
    return limit("tokenizer", "regexesPerLanguage", regexes.length, "regexes");

  const states = new Set<string>();
  for (const [i, state] of tokenizer.states.entries()) {
    if (
      states.has(state.name) ||
      forbiddenKeys.has(state.name) ||
      ["pop", "popall", "push"].includes(state.name)
    )
      return fail("tokenizer", `Duplicate or reserved state ${state.name}.`, {
        fieldPath: `states[${i}].name`,
      });
    states.add(state.name);
  }
  if (!states.has("root"))
    return fail("tokenizer", "A root state is required.", { fieldPath: "states" });
  const lists = new Set<string>();
  for (const [i, list] of (tokenizer.lists ?? []).entries()) {
    if (
      lists.has(list.name) ||
      forbiddenKeys.has(list.name) ||
      ["default", "eos"].includes(list.name)
    )
      return fail("tokenizer", `Duplicate or reserved list ${list.name}.`, {
        fieldPath: `lists[${i}].name`,
      });
    lists.add(list.name);
    const seen = new Set<string>();
    for (const [j, word] of list.words.entries()) {
      const key = tokenizer.ignoreCase ? word.toLowerCase() : word;
      if (seen.has(key))
        return fail("tokenizer", "Duplicate keyword after case folding.", {
          fieldPath: `lists[${i}].words[${j}]`,
        });
      seen.add(key);
    }
  }
  const actionProblem = (
    action: TokenAction,
    fieldPath: string,
  ): StaticLanguageValidationResult | undefined => {
    if (
      action.next &&
      !["@pop", "@popall"].includes(action.next) &&
      !states.has(action.next.slice(1))
    )
      return fail("tokenizer", `Missing or unsupported next state ${action.next}.`, {
        fieldPath: `${fieldPath}.next`,
      });
    if (
      action.token === "@brackets" &&
      (!tokenizer.brackets?.length || action.bracket !== undefined)
    )
      return fail(
        "tokenizer",
        "@brackets requires a nonempty bracket table and no bracket override.",
        { fieldPath: `${fieldPath}.token` },
      );
    return undefined;
  };
  for (const [i, state] of tokenizer.states.entries()) {
    for (const [j, rule] of state.rules.entries()) {
      if (!("regex" in rule)) continue;
      const path = `states[${i}].rules[${j}].action`;
      if ("cases" in rule.action) {
        const seen = new Set<string>();
        const cases = rule.action.cases;
        if (cases.at(-1)?.when !== "@default")
          return fail("tokenizer", "The last case must be @default.", {
            fieldPath: `${path}.cases`,
          });
        for (const [k, branch] of cases.entries()) {
          const branchPath = `${path}.cases[${k}]`;
          if (seen.has(branch.when) || (branch.when === "@default" && k !== cases.length - 1))
            return fail("tokenizer", "Cases must be unique with exactly one final @default.", {
              fieldPath: `${branchPath}.when`,
            });
          seen.add(branch.when);
          if (!["@default", "@eos"].includes(branch.when) && !lists.has(branch.when.slice(1)))
            return fail("tokenizer", `Missing case list ${branch.when}.`, {
              fieldPath: `${branchPath}.when`,
            });
          const problem = actionProblem(branch.action, `${branchPath}.action`);
          if (problem) return problem;
        }
      } else {
        const problem = actionProblem(rule.action, path);
        if (problem) return problem;
      }
    }
  }
  for (const [i, pair] of (configuration.autoClosingPairs ?? []).entries())
    if (pair.notIn && new Set(pair.notIn).size !== pair.notIn.length)
      return fail("configuration", "notIn entries must be unique.", {
        fieldPath: `autoClosingPairs[${i}].notIn`,
      });
  const graph = inspectStaticLanguageGraph(tokenizer);
  if (!graph.ok) {
    return fail("tokenizer", graph.message, {
      fieldPath: graph.fieldPath,
      ...(graph.limit === undefined
        ? {}
        : {
            limit: graph.limit,
            allowed: graph.allowed!,
            actual: graph.actual!,
          }),
    });
  }
  for (const entry of regexes) {
    const problem = checkStaticRegex(entry.data, entry.resource, tokenizer.ignoreCase);
    if (problem) {
      const { field, message, ...detail } = problem;
      return fail(entry.resource, message, { ...detail, fieldPath: `${entry.fieldPath}.${field}` });
    }
  }
  return {
    ok: true,
    tokenizer,
    configuration,
    resourceBytes: { ...input.resourceBytes },
    rules,
    regexes: regexes.length,
    expandedRules: graph.expandedRules,
  };
}
