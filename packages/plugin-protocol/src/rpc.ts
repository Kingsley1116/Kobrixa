import { z } from "zod";
import { PLUGIN_LIMITS } from "./limits.js";

export const jsonRpcIdSchema = z.union([
  z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().min(1).max(64),
]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
const version = z.literal("2.0");
const method = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[$A-Za-z][A-Za-z0-9/_-]*$/);
// Kobrixa methods always use object params and null or object results.
const params = z.looseObject({});

export const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: version,
  id: jsonRpcIdSchema,
  method,
  params: params.optional(),
});
export const jsonRpcNotificationSchema = z.strictObject({
  jsonrpc: version,
  method,
  params: params.optional(),
});
export const jsonRpcSuccessSchema = z.strictObject({
  jsonrpc: version,
  id: jsonRpcIdSchema,
  result: z.union([z.null(), z.looseObject({})]),
});
export const jsonRpcFailureSchema = z.strictObject({
  jsonrpc: version,
  id: z.union([jsonRpcIdSchema, z.null()]),
  error: z.strictObject({
    code: z.int().min(-2147483648).max(2147483647),
    message: z.string().max(PLUGIN_LIMITS.errorMessageLength),
  }),
});
export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcSuccessSchema,
  jsonRpcFailureSchema,
]);
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;
