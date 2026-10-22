import type {
  DeviceResourceParticipant,
  DeviceRequirement,
  Principal,
  AuthorityBinding,
} from "./device-resources.js";
import type { PersistenceParticipant, DrainDispatcher } from "./persistence-participant.js";
import type { CoreWindowScope } from "./core-actions.js";
import type {
  RpcPeer,
  DrainReason,
  ResourceOwner,
  Handle,
  Permission,
  ContextCommandDeclaration,
  CommandInvocation,
  CommandValue,
  Result,
} from "@kobrixa/plugin-protocol";
import type { UiCatalogPort } from "./ui-host-ports.js";
export type OwnerRetirement = Exclude<DrainReason, "reservation-ended"> | "crashed";
export interface Stage3ChannelContext {
  peer: RpcPeer;
  owner: ResourceOwner;
  principal(): Principal;
  requirements: readonly DeviceRequirement[];
}
export interface Stage3ChannelBinding {
  initialized(signal: AbortSignal): Promise<void>;
  ready(signal: AbortSignal): Promise<void>;
  dispose(): void;
}
export interface Stage3HostAttachment {
  hostEpoch: Handle;
  principal(owner: ResourceOwner): Principal;
  hasPermission(owner: ResourceOwner, permission: Permission): boolean;
  requirements(owner: ResourceOwner): readonly DeviceRequirement[] | null;
  bindChannel(context: Stage3ChannelContext): Stage3ChannelBinding;
  retireResources(owner: ResourceOwner, reason: OwnerRetirement): Promise<void>;
}
export interface UiRuntimeAttachment {
  activateInitialized(sourceKey: string, signal: AbortSignal): Promise<Stage3ChannelContext>;
  ready(owner: ResourceOwner, signal: AbortSignal): Promise<void>;
  current(owner: ResourceOwner): boolean;
  owners(): readonly ResourceOwner[];
  context(owner: ResourceOwner, scope: CoreWindowScope): AuthorityBinding;
  commands(sourceKey: string): readonly ContextCommandDeclaration[];
  invoke(
    owner: ResourceOwner,
    invocation: CommandInvocation,
    signal: AbortSignal,
  ): Promise<Result<CommandValue>>;
  dispatchDrain: DrainDispatcher;
}
export interface Stage3RuntimePorts {
  device: DeviceResourceParticipant;
  persistence: PersistenceParticipant;
  ui: UiCatalogPort;
}

import { randomUUID } from "node:crypto";
import type { ResourceOwner as RetirementOwner150 } from "@kobrixa/plugin-protocol";
import type {
  DeviceDisposition as DeviceDisposition150,
  RetirementReason as RetirementReason150,
} from "./device-resources.js";
import type {
  DrainDispatcher as DrainDispatcher150,
  DrainOffer as DrainOffer150,
  DrainReport as DrainReport150,
  PersistenceParticipant as PersistenceParticipant150,
} from "./persistence-participant.js";

export type RetirementDisposition = { device: DeviceDisposition150; persistence: DrainReport150 };
const retirementResults = new WeakMap<
  Stage3RuntimePorts,
  Map<string, Promise<RetirementDisposition>>
>();
const deviceRetirementReason: Record<OwnerRetirement, RetirementReason150> = {
  disable: "disabled",
  reload: "reload",
  remove: "disabled",
  crashed: "crashed",
  "renderer-crash": "renderer-lost",
  "window-destroyed": "renderer-lost",
  shutdown: "shutdown",
  update: "shutdown",
  "safe-mode": "safe-mode",
};
export function retireStage3Owner(
  ports: Stage3RuntimePorts,
  owner: RetirementOwner150,
  reason: OwnerRetirement,
  now: () => number,
  dispatch: DrainDispatcher150,
  deadlineMonotonicMs?: number,
): Promise<RetirementDisposition> {
  let completed = retirementResults.get(ports);
  if (!completed) {
    completed = new Map();
    retirementResults.set(ports, completed);
  }
  const key = JSON.stringify([
    owner.sourceKey,
    owner.pluginId,
    owner.generation,
    owner.hostEpoch,
    owner.processEpoch,
  ]);
  const existing = completed.get(key);
  if (existing) return existing;
  let resolve!: (value: RetirementDisposition) => void;
  let reject!: (error: unknown) => void;
  const receipt = new Promise<RetirementDisposition>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Publish before fencing: reentrant reservation notifications join this receipt.
  completed.set(key, receipt);
  try {
    const t0 = now();
    const device = ports.device.retire(owner, deviceRetirementReason[reason]);
    ports.ui.retire(owner);
    const deadline = Math.min(
      t0 + 10_000,
      deadlineMonotonicMs ?? Infinity,
      device.drain?.expiresMonotonicMs ?? Infinity,
    );
    const offer =
      reason === "crashed"
        ? null
        : device.drain === null
          ? ports.persistence.freeze(owner, reason, deadline)
          : ports.persistence.freeze(owner, reason, deadline, device.drain);
    const storage = Promise.resolve().then(() => {
      if (!offer) return ports.persistence.ownerLost(owner);
      // freeze coalesces any end offer; never extend its original deadline.
      const remaining = Math.max(0, Math.min(deadline, offer.deadlineMonotonicMs) - now());
      const signal = AbortSignal.timeout(Math.floor(remaining));
      return ports.persistence.drain(offer, (original, request, callerSignal) =>
        dispatch(original, request, AbortSignal.any([callerSignal, signal])),
      );
    });
    void Promise.all([device.settled, storage]).then(
      ([device, persistence]) => resolve({ device, persistence }),
      reject,
    );
  } catch (error) {
    reject(error);
  }
  // Keep receipts for this ports lifetime: unresolved evidence and retired generations
  // are never re-admitted by an eviction policy.
  return receipt;
}

export function unavailableUi150(): Stage3RuntimePorts["ui"] {
  const unavailable = {
    ok: false as const,
    error: {
      code: "PLUGIN_E_DISABLED" as const,
      message: "Declarative UI is unavailable before API 1.6.0.",
    },
  };
  return {
    async catalog() {
      return unavailable;
    },
    async resource() {
      return unavailable;
    },
    retire() {},
    onEvent() {
      return () => {};
    },
  };
}

export function resourceFreePersistence150(): PersistenceParticipant150 {
  const offers = new WeakSet<DrainOffer150>();
  const empty = (): DrainReport150 => ({
    state: "saved",
    blocker: false,
    pendingSettings: false,
    records: [],
    errors: [],
  });
  return {
    endReservation() {
      return null;
    },
    freeze(owner, reason, deadline) {
      const offer: DrainOffer150 = Object.freeze({
        owner,
        reason,
        deadlineMonotonicMs: deadline,
        token: randomUUID(),
        checkpoints: [],
        writes: [],
        acceptedTickets: [],
      });
      offers.add(offer);
      return offer;
    },
    async drain(offer) {
      if (
        !offers.has(offer) ||
        offer.checkpoints.length ||
        offer.writes.length ||
        offer.acceptedTickets.length
      )
        throw new Error("The API 1.5 resource-free adapter cannot save storage work.");
      return empty();
    },
    async ownerLost() {
      return empty();
    },
    recoverySnapshot() {
      return { revision: 0, items: [] };
    },
    async retry() {
      throw new Error("No API 1.5 persistence recovery action exists.");
    },
    async discard() {
      throw new Error("No API 1.5 persistence recovery action exists.");
    },
  };
}
