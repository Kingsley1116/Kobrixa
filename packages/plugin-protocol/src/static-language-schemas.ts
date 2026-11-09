import { STATIC_LANGUAGE_LIMITS_V1 as L } from "./static-language-limits.js";
import { z } from "zod";

// eslint-disable-next-line no-control-regex -- wire text rejects all C0/C1 controls.
const TEXT = /^[^\u0000-\u001f\u007f-\u009f]*$(?![\r\n\u2028\u2029])/u;
// eslint-disable-next-line no-control-regex -- aliases also reject Unicode line separators.
const SINGLE_LINE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$(?![\r\n\u2028\u2029])/u;

export function staticLanguageText(minimum: number, maximum: number, singleLine = false) {
  return z
    .string()
    .min(minimum)
    .max(maximum)
    .regex(singleLine ? SINGLE_LINE_TEXT : TEXT);
}

// ASCII grammars exclude controls themselves. One regex per string avoids
// emitting allOf, which the existing Python schema keyword set does not use.
const name = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]{0,31}$(?![\r\n\u2028\u2029])/);
const reference = z
  .string()
  .min(2)
  .max(33)
  .regex(/^@[a-z][a-z0-9_]{0,31}$(?![\r\n\u2028\u2029])/);
const literalToken = z
  .string()
  .min(0)
  .max(80)
  .regex(/^(?:[a-z][a-z0-9_.-]*)?$(?![\r\n\u2028\u2029])/);
export const regexDataSchema = z.strictObject({
  pattern: staticLanguageText(1, L.patternLength),
  flags: z.enum(L.regexFlags),
});
export const pairSchema = z.strictObject({
  open: staticLanguageText(1, 16),
  close: staticLanguageText(1, 16),
});
export const tokenActionSchema = z.strictObject({
  token: z.union([literalToken, z.literal("@brackets")]),
  next: reference.optional(),
  bracket: z.enum(["@open", "@close"]).optional(),
});
export const actionSchema = z.union([
  tokenActionSchema,
  z.strictObject({
    cases: z
      .array(
        z.strictObject({
          when: reference,
          action: tokenActionSchema,
        }),
      )
      .min(1)
      .max(L.casesPerRule),
  }),
]);
export const ruleSchema = z.union([
  z.strictObject({ regex: regexDataSchema, action: actionSchema }),
  z.strictObject({ include: reference }),
]);
export const staticLanguageTokenizerV1Schema = z.strictObject({
  ignoreCase: z.boolean(),
  defaultToken: literalToken.optional(),
  tokenPostfix: z
    .string()
    .min(2)
    .max(80)
    .regex(/^\.[a-z][a-z0-9_.-]*$(?![\r\n\u2028\u2029])/)
    .optional(),
  lists: z
    .array(
      z.strictObject({
        name,
        words: z.array(staticLanguageText(1, 64)).max(L.wordsPerLanguage),
      }),
    )
    .max(L.listsPerLanguage)
    .optional(),
  brackets: z
    .array(pairSchema.extend({ token: literalToken }))
    .max(32)
    .optional(),
  states: z
    .array(
      z.strictObject({
        name,
        rules: z.array(ruleSchema).max(L.rulesPerLanguage),
      }),
    )
    .min(1)
    .max(L.statesPerLanguage),
});
export const staticLanguageConfigurationV1Schema = z.strictObject({
  comments: z
    .strictObject({
      lineComment: staticLanguageText(1, 16).optional(),
      blockComment: pairSchema.optional(),
    })
    .optional(),
  brackets: z.array(pairSchema).max(32).optional(),
  autoClosingPairs: z
    .array(
      pairSchema.extend({
        notIn: z
          .array(z.enum(["string", "comment", "regex"]))
          .max(3)
          .optional(),
      }),
    )
    .max(32)
    .optional(),
  surroundingPairs: z.array(pairSchema).max(32).optional(),
  indentationRules: z
    .strictObject({
      increaseIndentPattern: regexDataSchema,
      decreaseIndentPattern: regexDataSchema,
      indentNextLinePattern: regexDataSchema.optional(),
      unIndentedLinePattern: regexDataSchema.optional(),
    })
    .optional(),
  onEnterRules: z
    .array(
      z.strictObject({
        beforeText: regexDataSchema,
        afterText: regexDataSchema.optional(),
        previousLineText: regexDataSchema.optional(),
        action: z.strictObject({
          indentAction: z.enum(["none", "indent", "indentOutdent", "outdent"]),
          appendText: staticLanguageText(0, 256).optional(),
          removeText: z.number().int().min(0).max(256).optional(),
        }),
      }),
    )
    .max(L.onEnterRules)
    .optional(),
  wordPattern: regexDataSchema.optional(),
});

export type RegexData = z.infer<typeof regexDataSchema>;
export type Pair = z.infer<typeof pairSchema>;
export type TokenAction = z.infer<typeof tokenActionSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type StaticLanguageTokenizerV1 = z.infer<typeof staticLanguageTokenizerV1Schema>;
export type StaticLanguageConfigurationV1 = z.infer<typeof staticLanguageConfigurationV1Schema>;
