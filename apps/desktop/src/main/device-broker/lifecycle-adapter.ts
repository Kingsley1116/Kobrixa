import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  DeviceDrainGrant,
  DeviceResourceParticipant,
  Principal,
  RetirementReason,
} from "@kobrixa/plugin-runtime";
import { ownerKey } from "./rpc-bindings.js";

export type CleanupClass = "closed" | "ordinary" | "original-motion" | "final-read";
export interface CleanupLookup {
  operationOwner(operationId: string): Principal | null;
  drain(reservationId: string): DeviceDrainGrant | null;
}
export function classifyCleanup(
  principal: Principal,
  method: string,
  params: Readonly<Record<string, unknown>>,
  channelOpen: boolean,
  now: number,
  lookup: CleanupLookup,
): CleanupClass {
  if (!channelOpen) return "closed";
  if (
    (method === "devices/motion/query" || method === "devices/motion/stop") &&
    typeof params.operationId === "string"
  ) {
    const original = lookup.operationOwner(params.operationId);
    if (original && ownerKey(original) === ownerKey(principal)) return "original-motion";
  }
  if (
    principal.kind === "plugin" &&
    (method === "devices/recording/query" || method === "devices/recording/read") &&
    typeof params.reservationId === "string"
  ) {
    const grant = lookup.drain(params.reservationId);
    if (!grant || now >= grant.expiresMonotonicMs) return "ordinary";
    const bound: Principal = { kind: "plugin", owner: grant.owner, authorityContext: null };
    if (ownerKey(bound) !== ownerKey(principal)) return "ordinary";
    if (
      method === "devices/recording/read" &&
      (typeof params.afterSequence !== "number" ||
        !Number.isSafeInteger(params.afterSequence) ||
        params.afterSequence < 0 ||
        params.afterSequence > grant.lastSequence)
    )
      return "ordinary";
    return "final-read";
  }
  return "ordinary";
}
export function retireDeviceOwner(
  resources: DeviceResourceParticipant,
  owner: ResourceOwner,
  reason: RetirementReason,
): ReturnType<DeviceResourceParticipant["retire"]> {
  return resources.retire(owner, reason);
}
