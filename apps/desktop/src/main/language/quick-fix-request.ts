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
    requestId: quickFixRequestIdSchema,
    session: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    analysisVersion: z.number().int().positive(),
    file: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes("\0")),
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
          .strict()
          .refine(
            (range) =>
              range.endLine > range.startLine ||
              (range.endLine === range.startLine && range.endColumn >= range.startColumn),
          ),
      })
      .strict(),
  })
  .strict();
