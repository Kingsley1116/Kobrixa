import { uiFormRequestSchemasV2, validUiFormWireV2 } from "./ui-v2-form.js";
import { z } from "zod";
import { uiRequestSchemas } from "./ui-methods.js";
import {
  uiBindingSchema,
  uiSubscriptionSnapshotSchema,
  uiResultSchema,
  uiEventEnvelopeSchema,
} from "./ui-types.js";
import { handleSchema, counterSchema, resourceOwnerSchema } from "./device-types.js";
import {
  uiDataEventSchemaV2,
  uiDataMetadataSchemaV2,
  uiDataRequestSchemasV2,
  validateUiDataReadValueV2,
  validateUiDataSnapshotValueV2,
} from "./ui-v2-methods.js";
import { validateDatasetHeaderV2, validateDatasetChunkV2 } from "./ui-v2-data.js";
import { validUiWire } from "./ui-validation.js";
import type { DefinitionMap } from "./business-result.js";

export const uiResourceVersionsV2Schema = z.union([
  z.tuple([]),
  z.tuple([z.literal(1)]),
  z.tuple([z.literal(2)]),
  z.tuple([z.literal(1), z.literal(2)]),
]);
export const uiSubscriptionSnapshotV2Schema = uiSubscriptionSnapshotSchema.extend({
  // Omitted when the subscription has no data topic. No payloads in this DTO.
  data: z
    .array(
      z.strictObject({
        binding: uiBindingSchema.extend({ kind: z.literal("panel") }),
        datasets: z.array(uiDataMetadataSchemaV2).max(8),
      }),
    )
    .max(4)
    .exactOptional(),
});
export const uiRequestSchemasV2 = {
  ...uiRequestSchemas,
  ...uiDataRequestSchemasV2,
  ...uiFormRequestSchemasV2,
  "ui/negotiate": {
    params: z.strictObject({
      commandEnvelopeVersions: z.tuple([z.literal(1)]),
      uiResourceVersions: uiResourceVersionsV2Schema,
    }),
    result: uiResultSchema(
      z.strictObject({
        commandEnvelopeVersions: z.union([z.tuple([]), z.tuple([z.literal(1)])]),
        uiResourceVersions: uiResourceVersionsV2Schema,
      }),
    ),
  },
  "ui/subscribe": {
    params: uiRequestSchemas["ui/subscribe"].params.extend({
      topics: z
        .array(z.enum(["instances", "visibility", "environment", "form", "state", "data"]))
        .min(1)
        .max(6),
    }),
    result: uiResultSchema(
      z.strictObject({
        subscriptionId: handleSchema,
        sequence: z.literal(0),
        snapshot: uiSubscriptionSnapshotV2Schema,
      }),
    ),
  },
  "ui/snapshot": {
    params: uiRequestSchemas["ui/snapshot"].params,
    result: uiResultSchema(
      z.strictObject({ sequence: counterSchema, snapshot: uiSubscriptionSnapshotV2Schema }),
    ),
  },
};
export type UiRequestMapV2 = DefinitionMap<typeof uiRequestSchemasV2>;
export const uiDataEventEnvelopeSchemaV2 = uiDataEventSchemaV2.extend({
  version: z.literal(1),
  subscriptionId: handleSchema,
  owner: resourceOwnerSchema,
  sequence: counterSchema,
  delivery: z.literal("telemetry"),
});
export const uiEventEnvelopeSchemaV2 = z.union([
  uiEventEnvelopeSchema,
  uiDataEventEnvelopeSchemaV2,
]);
export type UiEventEnvelopeV2 = z.infer<typeof uiEventEnvelopeSchemaV2>;
export const isUiDataMethod = (method: string): boolean =>
  Object.hasOwn(uiDataRequestSchemasV2, method);
export const isUiV2OnlyMethod = (method: string): boolean =>
  isUiDataMethod(method) || Object.hasOwn(uiFormRequestSchemasV2, method);
export const supportsUiV2 = (version: string): boolean =>
  /^1\.(?:[89]|[1-9][0-9]+)\.\d+$/.test(version);
/** Semantic checks after the selected session's structural wire parser. */
export function validUiWireV2(
  method: string,
  phase: "params" | "result",
  value: unknown,
  params?: unknown,
): boolean {
  if (method === "ui/formPatch") return validUiFormWireV2(phase, value, params);
  if (!validUiWire(method, phase, value, params)) return false;
  try {
    if (phase === "params") {
      if (method === "ui/dataBegin")
        validateDatasetHeaderV2(uiDataRequestSchemasV2[method].params.parse(value).header);
      if (method === "ui/dataChunk")
        validateDatasetChunkV2(uiDataRequestSchemasV2[method].params.parse(value).chunk);
      if (method === "ui/subscribe") {
        const item = uiRequestSchemasV2[method].params.parse(value);
        if (item.topics.includes("data") && item.binding?.kind !== "panel") return false;
      }
    } else {
      if (method === "ui/dataRead") {
        const item = uiDataRequestSchemasV2[method].result.parse(value);
        if (item.ok)
          validateUiDataReadValueV2(
            item.value,
            uiDataRequestSchemasV2[method].params.parse(params),
          );
      }
      if (method === "ui/dataSnapshot") {
        const item = uiDataRequestSchemasV2[method].result.parse(value);
        if (item.ok) validateUiDataSnapshotValueV2(item.value);
      }
      if (method === "ui/negotiate") {
        const item = uiRequestSchemasV2[method].result.parse(value);
        const offered = uiRequestSchemasV2[method].params.parse(params);
        if (
          item.ok &&
          (item.value.uiResourceVersions.some(
            (v) => !offered.uiResourceVersions.some((version) => version === v),
          ) ||
            item.value.commandEnvelopeVersions.some(
              (v) => !offered.commandEnvelopeVersions.some((version) => version === v),
            ))
        )
          return false;
      }
      if (method === "ui/subscribe" || method === "ui/snapshot") {
        const item = uiRequestSchemasV2[method].result.parse(value);
        if (item.ok) {
          const groups = item.value.snapshot.data ?? [];
          if (new Set(groups.map((g) => JSON.stringify(g.binding))).size !== groups.length)
            return false;
          for (const group of groups) validateUiDataSnapshotValueV2({ datasets: group.datasets });
          if (method === "ui/subscribe") {
            const request = uiRequestSchemasV2[method].params.parse(params);
            if (request.topics.includes("data") && !item.value.snapshot.data) return false;
            if (
              groups.some(
                (group) => JSON.stringify(group.binding) !== JSON.stringify(request.binding),
              )
            )
              return false;
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
