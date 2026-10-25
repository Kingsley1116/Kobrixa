import { z } from "zod";
import type { DefinitionMap } from "./business-result.js";
import { permissionErrorDetailSchema } from "./business-result.js";
import { counterSchema, handleSchema, wireText } from "./device-types.js";
import { localIdSchema } from "./ui-resource.js";
import { uiBindingSchema } from "./ui-types.js";
import {
  datasetHeaderV2Schema,
  datasetChunkV2Schema,
  validateDatasetHeaderV2,
  validateDatasetChunkV2,
  UiDataValidationErrorV2,
} from "./ui-v2-data.js";

/** Unpublished v2 data-plane wire leaves. These do not register public methods,
 * negotiate v2, or authorize an owner. Host admission remains mandatory.
 */
const panelBinding = uiBindingSchema.extend({ kind: z.literal("panel") });
const positiveCounter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = positiveCounter.max(524288);
const remainingMs = z.number().min(0).max(10000);
const base = { binding: panelBinding, dataset: localIdSchema };
const metadata = {
  revision: positiveCounter,
  presentation: positiveCounter,
  byteLength: bytes,
  sha256,
};
const failure = <C extends string, R extends readonly [string, ...string[]]>(code: C, reasons: R) =>
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.literal(code),
      message: wireText(1, 2000),
      detail: z.strictObject({ kind: z.literal("ui-data"), reason: z.enum(reasons) }),
    }),
  });
export const uiDataFailureSchemaV2 = z.union([
  failure("PLUGIN_E_UI_RESOURCE", ["schema", "reference", "offset", "checksum"]),
  failure("PLUGIN_E_STALE_RESOURCE", ["revision", "expired", "stale"]),
  failure("PLUGIN_E_RESOURCE_LIMIT", ["quota", "rate", "queue"]),
  failure("PLUGIN_E_UI_VERSION", ["version"]),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.literal("PLUGIN_E_PERMISSION_DENIED"),
      message: wireText(1, 2000),
      detail: permissionErrorDetailSchema,
    }),
  }),
]);
export type UiDataFailureV2 = z.infer<typeof uiDataFailureSchemaV2>;
export type UiDataResultV2<T> = { ok: true; value: T } | UiDataFailureV2;
export function uiDataResultSchemaV2<V extends z.ZodType>(value: V) {
  return z.union([z.strictObject({ ok: z.literal(true), value }), uiDataFailureSchemaV2]);
}
export const uiDataMetadataSchemaV2 = z.strictObject({ dataset: localIdSchema, ...metadata });
const readFields = { ...metadata, nextOffset: counterSchema, done: z.boolean() };
// Each header and chunk kind is paired in the exportable wire schema itself.
const readVariants = datasetHeaderV2Schema.options.map((header) => {
  const chunk = datasetChunkV2Schema.options.find(
    (c) => c.shape.kind.value === header.shape.kind.value,
  )!;
  return z.strictObject({ ...readFields, header, chunk });
});
export const uiDataReadValueSchemaV2 = z.union(readVariants);
export const uiDataSnapshotValueSchemaV2 = z.strictObject({
  datasets: z.array(uiDataMetadataSchemaV2).max(8),
});
export const uiDataRequestSchemasV2 = {
  "ui/dataBegin": {
    params: z.strictObject({
      ...base,
      baseRevision: counterSchema,
      presentation: positiveCounter,
      header: datasetHeaderV2Schema,
      entryCount: z.number().int().min(0).max(16384),
      byteLength: bytes,
      sha256,
    }),
    result: uiDataResultSchemaV2(
      z.strictObject({ transfer: handleSchema, nextOffset: z.literal(0), remainingMs }),
    ),
  },
  "ui/dataChunk": {
    params: z.strictObject({
      ...base,
      transfer: handleSchema,
      offset: counterSchema,
      chunk: datasetChunkV2Schema,
    }),
    result: uiDataResultSchemaV2(z.strictObject({ nextOffset: counterSchema, remainingMs })),
  },
  "ui/dataCommit": {
    params: z.strictObject({ ...base, transfer: handleSchema }),
    result: uiDataResultSchemaV2(z.strictObject(metadata)),
  },
  "ui/dataAbort": {
    params: z.strictObject({ ...base, transfer: handleSchema }),
    result: uiDataResultSchemaV2(z.strictObject({ aborted: z.boolean() })),
  },
  "ui/dataRead": {
    params: z.strictObject({
      ...base,
      revision: positiveCounter,
      offset: counterSchema,
      limit: z.number().int().min(1).max(256),
    }),
    result: uiDataResultSchemaV2(uiDataReadValueSchemaV2),
  },
  "ui/dataSnapshot": {
    params: z.strictObject({ binding: panelBinding }),
    result: uiDataResultSchemaV2(uiDataSnapshotValueSchemaV2),
  },
} satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;
export type UiDataRequestMapV2 = DefinitionMap<typeof uiDataRequestSchemasV2>;
export const uiDataEventSchemaV2 = z.strictObject({
  kind: z.literal("ui.data"),
  data: z.strictObject({ ...base, revision: positiveCounter, presentation: positiveCounter }),
});

/** Explicit semantic checks follow wire parsing; no refinements enter schema export. */
export function validateUiDataReadValueV2(
  input: unknown,
  request: { revision: number; offset: number; limit: number },
) {
  const result = uiDataReadValueSchemaV2.safeParse(input);
  if (!result.success) throw new UiDataValidationErrorV2("schema");
  const value = result.data;
  if (
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0 ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 256 ||
    value.revision !== request.revision ||
    value.chunk.entries.length > request.limit ||
    value.nextOffset !== request.offset + value.chunk.entries.length ||
    (!value.done && value.chunk.entries.length === 0)
  )
    throw new UiDataValidationErrorV2("reference");
  validateDatasetHeaderV2(value.header);
  validateDatasetChunkV2(value.chunk, value.header);
  // The page budget includes the business-result wrapper, not only its entries.
  if (new TextEncoder().encode(JSON.stringify({ ok: true, value })).byteLength > 49152)
    throw new UiDataValidationErrorV2("quota");
  return value;
}
export function validateUiDataSnapshotValueV2(input: unknown) {
  const result = uiDataSnapshotValueSchemaV2.safeParse(input);
  if (!result.success) throw new UiDataValidationErrorV2("schema");
  const ids = result.data.datasets.map((d) => d.dataset);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => ["constructor", "prototype", "__proto__"].includes(id))
  )
    throw new UiDataValidationErrorV2("reference");
  return result.data;
}
/** Measure actual encoded frames before parsing or after serialization. Never
 * reserialize incoming JSON: whitespace and escape expansion count on the wire. */
export function assertUiDataFrameBudgetV2(frame: string | Uint8Array): void {
  if (
    (typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength) >
    65536
  )
    throw new UiDataValidationErrorV2("quota");
}
