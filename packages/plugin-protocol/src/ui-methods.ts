import type { z } from "zod";
import type { DefinitionMap } from "./business-result.js";
import type { Handle, Counter } from "./device-types.js";
import type { Scalar, LocalId } from "./ui-resource.js";
import type {
  Result, UiBinding, UiStateSnapshot, UiSubscriptionSnapshot,
  CommandInvocation, CommandValue,
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
    params: { topics: ("instances" | "visibility" | "environment" | "form" | "state")[]; binding?: UiBinding };
    result: Result<{ subscriptionId: Handle; sequence: 0; snapshot: UiSubscriptionSnapshot }>;
  };
  "ui/snapshot": {
    params: { subscriptionId: Handle };
    result: Result<{ sequence: Counter; snapshot: UiSubscriptionSnapshot }>;
  };
};
export declare const uiRequestSchemas: {
  [M in keyof FrozenUiMethods]: {
    params: z.ZodType<FrozenUiMethods[M]["params"], FrozenUiMethods[M]["params"]>;
    result: z.ZodType<FrozenUiMethods[M]["result"]>;
  };
};
export type UiRequestMap = DefinitionMap<typeof uiRequestSchemas>;
