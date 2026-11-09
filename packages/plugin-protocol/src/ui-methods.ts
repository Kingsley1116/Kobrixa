import { z } from "zod";
import type { DefinitionMap } from "./business-result.js";
import type { Handle, Counter } from "./device-types.js";
import type { Scalar, LocalId } from "./ui-resource.js";
import type {
  Result,
  UiBinding,
  UiStateSnapshot,
  UiSubscriptionSnapshot,
  CommandInvocation,
  CommandValue,
} from "./ui-types.js";
// 新增；Result<T> 使用 3A 凍結的 {ok:true,value:T}／{ok:false,error}。
export type UiNegotiateParams = {
  commandEnvelopeVersions: [1];
  uiResourceVersions: number[]; // 1.6.0 host 精確為 [1]
};
export type UiNegotiateValue = {
  commandEnvelopeVersions: number[]; // 只接受 [] 或 [1]
  uiResourceVersions: number[]; // 1.6.0 SDK 只接受 [] 或 [1]
};

type FrozenUiMethods = {
  "ui/negotiate": { params: UiNegotiateParams; result: Result<UiNegotiateValue> };
  "ui/ready": { params: Record<string, never>; result: Result<Record<string, never>> };
  "command/invoke": { params: CommandInvocation; result: Result<CommandValue> };
  "ui/instances": { params: Record<string, never>; result: Result<{ instances: UiBinding[] }> };
  "ui/state": { params: { binding: UiBinding }; result: Result<UiStateSnapshot> };
  "ui/patch": {
    params: { binding: UiBinding; baseRevision: Counter; set: Record<LocalId, Scalar> };
    result: Result<{ revision: Counter }>;
  };
  "ui/subscribe": {
    params: {
      topics: ("instances" | "visibility" | "environment" | "form" | "state")[];
      binding?: UiBinding;
    };
    result: Result<{ subscriptionId: Handle; sequence: 0; snapshot: UiSubscriptionSnapshot }>;
  };
  "ui/snapshot": {
    params: { subscriptionId: Handle };
    result: Result<{ sequence: Counter; snapshot: UiSubscriptionSnapshot }>;
  };
};
import { localIdSchema, uiScalarSchema } from "./ui-resource.js";
import { handleSchema, counterSchema, wireText } from "./device-types.js";
import {
  uiBindingSchema,
  uiStateSnapshotSchema,
  uiSubscriptionSnapshotSchema,
  commandInvocationSchema,
  commandValueSchema,
  uiResultSchema,
} from "./ui-types.js";
const empty = z.strictObject({});
const versions = z.union([z.tuple([]), z.tuple([z.literal(1)])]);
export const uiRequestSchemas = {
  "ui/negotiate": {
    params: z.strictObject({
      commandEnvelopeVersions: z.tuple([z.literal(1)]),
      uiResourceVersions: z.array(z.number().int().min(1).max(65535)).max(16),
    }),
    result: uiResultSchema(
      z.strictObject({ commandEnvelopeVersions: versions, uiResourceVersions: versions }),
    ),
  },
  "ui/ready": { params: empty, result: uiResultSchema(empty) },
  "command/invoke": {
    params: commandInvocationSchema,
    result: z.union([
      uiResultSchema(commandValueSchema),
      z.strictObject({
        ok: z.literal(false),
        error: z.strictObject({
          code: z.enum(["PLUGIN_E_COMMAND_FAILED", "PLUGIN_E_CANCELLED", "PLUGIN_E_TIMEOUT"]),
          message: wireText(1, 2000),
        }),
      }),
    ]),
  },
  "ui/instances": {
    params: empty,
    result: uiResultSchema(z.strictObject({ instances: z.array(uiBindingSchema).max(6) })),
  },
  "ui/state": {
    params: z.strictObject({ binding: uiBindingSchema }),
    result: uiResultSchema(uiStateSnapshotSchema),
  },
  "ui/patch": {
    params: z.strictObject({
      binding: uiBindingSchema,
      baseRevision: counterSchema,
      set: z.record(localIdSchema, uiScalarSchema),
    }),
    result: uiResultSchema(z.strictObject({ revision: counterSchema })),
  },
  "ui/subscribe": {
    params: z.strictObject({
      topics: z
        .array(z.enum(["instances", "visibility", "environment", "form", "state"]))
        .min(1)
        .max(5),
      binding: uiBindingSchema.exactOptional(),
    }),
    result: uiResultSchema(
      z.strictObject({
        subscriptionId: handleSchema,
        sequence: z.literal(0),
        snapshot: uiSubscriptionSnapshotSchema,
      }),
    ),
  },
  "ui/snapshot": {
    params: z.strictObject({ subscriptionId: handleSchema }),
    result: uiResultSchema(
      z.strictObject({ sequence: counterSchema, snapshot: uiSubscriptionSnapshotSchema }),
    ),
  },
} satisfies {
  [M in keyof FrozenUiMethods]: {
    params: z.ZodType<FrozenUiMethods[M]["params"]>;
    result: z.ZodType<FrozenUiMethods[M]["result"]>;
  };
};
export type UiRequestMap = DefinitionMap<typeof uiRequestSchemas>;
