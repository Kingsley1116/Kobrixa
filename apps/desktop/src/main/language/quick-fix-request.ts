import { z } from "zod";

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
        code: z.string().regex(/^(BP|MAN|IR|EV3|BUILD)\d{4}$/),
        helpKey: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(100)
          .optional(),
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
