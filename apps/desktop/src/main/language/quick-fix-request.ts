import type { QuickFixRequest } from "../../shared/quick-fixes.js";
import { z } from "zod";
import {
  namespacedIdSchema,
  diagnosticCodeSchema,
  diagnosticHelpKeySchema,
} from "@kobrixa/plugin-protocol";

export const quickFixRequestIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

const position = z.number().int().positive().max(1_000_000_000);
export const quickFixRequestSchema = z
  .object({
    epoch: z.number().int().positive(),
    requestId: quickFixRequestIdSchema,
    session: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    analysisVersion: z.number().int().positive(),
    file: z
      .string()
      .min(1)
      .max(1024)
      // eslint-disable-next-line no-control-regex -- Reject NUL structurally in this exportable wire schema.
      .regex(/^[^\u0000]+$/),
    diagnostic: z
      .object({
        source: namespacedIdSchema,
        code: diagnosticCodeSchema,
        helpKey: diagnosticHelpKeySchema.optional(),
        range: z
          .object({
            startLine: position,
            startColumn: position,
            endLine: position,
            endColumn: position,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function validateQuickFixRequest(value: unknown): QuickFixRequest {
  const request = quickFixRequestSchema.parse(value);
  const r = request.diagnostic.range;
  if (r.endLine < r.startLine || (r.endLine === r.startLine && r.endColumn < r.startColumn))
    throw new Error("Quick fix range is reversed.");
  return request;
}

const languageFile = z
  .string()
  .min(1)
  .max(1024)
  // eslint-disable-next-line no-control-regex -- Reject NUL structurally in this exportable wire schema.
  .regex(/^[^\u0000]+$/);
const languageContent = z.string().max(8 * 1024 * 1024);
const epochSchema = z.number().int().positive();
const syncIdentity = {
  epoch: epochSchema,
  session: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative().nullable(),
};
const queryPosition = { file: languageFile, line: position, column: position };
export const languageFeatureRequestSchema = z.strictObject({
  requestId: quickFixRequestIdSchema,
  epoch: epochSchema,
  session: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  analysisVersion: z.number().int().positive(),
  query: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("hover"), ...queryPosition }),
    z.strictObject({ kind: z.literal("signatureHelp"), ...queryPosition }),
    z.strictObject({ kind: z.literal("definition"), ...queryPosition }),
    z.strictObject({
      kind: z.literal("references"),
      ...queryPosition,
      includeDeclaration: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("renameLocation"), ...queryPosition }),
    z.strictObject({
      kind: z.literal("rename"),
      ...queryPosition,
      newName: z.string().min(1).max(1024),
    }),
    z.strictObject({ kind: z.literal("documentSymbols"), file: languageFile }),
  ]),
});
export const languageSyncRequestSchema = z.strictObject({
  ...syncIdentity,
  analysisBase: z.number().int().positive().nullable(),
  overlays: z.strictObject({
    set: z.record(languageFile, languageContent),
    removed: z.array(languageFile),
  }),
});
export const completionSyncRequestSchema = z.strictObject({
  ...syncIdentity,
  refresh: z.boolean(),
  updates: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("reset"),
        file: languageFile,
        document: z.strictObject({
          version: z.number().int().nonnegative(),
          text: languageContent,
        }),
      }),
      z.strictObject({ kind: z.literal("remove"), file: languageFile }),
      z.strictObject({
        kind: z.literal("edit"),
        file: languageFile,
        before: z.number().int().nonnegative(),
        version: z.number().int().positive(),
        changes: z.array(
          z.strictObject({
            offset: z.number().int().nonnegative(),
            length: z.number().int().nonnegative(),
            text: languageContent,
          }),
        ),
      }),
    ]),
  ),
});
