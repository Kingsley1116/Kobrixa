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

import type { UiBinding } from "@kobrixa/plugin-protocol";
import type { UiStateRegistry } from "./ui-state.js";
import type { UiSubscriptions } from "./ui-subscriptions.js";
export function createUiLifetimePort(input: {
  catalog: UiCatalogPort;
  states: Pick<UiStateRegistry, "instances" | "retireExecution">;
  subscriptions: Pick<UiSubscriptions, "retire">;
  revoke(owner: ResourceOwner, binding: UiBinding): void;
}): UiCatalogPort {
  return {
    catalog: (value) => input.catalog.catalog(value),
    resource: (value) => input.catalog.resource(value),
    onEvent: (listener) => input.catalog.onEvent(listener),
    retire: (owner) => {
      for (const binding of input.states.instances(owner)) input.revoke(owner, binding);
      input.states.retireExecution(owner, "generation-retired");
      input.subscriptions.retire(owner);
      input.catalog.retire(owner);
    },
  };
}

const activationDeadlines = new WeakMap<AbortSignal, { deadline: number; now(): number }>();
export function registerActivationDeadline(
  signal: AbortSignal,
  deadline: number,
  now: () => number,
): () => void {
  if (activationDeadlines.has(signal)) throw new Error("Activation deadline already registered.");
  activationDeadlines.set(signal, { deadline, now });
  return () => {
    activationDeadlines.delete(signal);
  };
}
export function remainingActivationMs(signal: AbortSignal): number {
  signal.throwIfAborted();
  const entry = activationDeadlines.get(signal);
  if (!entry) throw new Error("Missing supervisor activation deadline.");
  const remaining = entry.deadline - entry.now();
  if (remaining <= 0) throw new Error("Activation deadline expired.");
  return remaining;
}

function phaseDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export class ChannelActivation {
  readonly #initialized = phaseDeferred<Stage3ChannelContext>();
  readonly #ready = phaseDeferred<void>();
  readonly initialized = this.#initialized.promise;
  readonly ready = this.#ready.promise;
  #run: Promise<void> | undefined;
  #disposed = false;
  readonly #disposal = phaseDeferred<never>();
  constructor(
    readonly context: Stage3ChannelContext,
    private readonly binding: Stage3ChannelBinding,
    private readonly signal: AbortSignal,
    private readonly current: () => boolean,
  ) {
    signal.addEventListener("abort", this.#abort, { once: true });
    if (signal.aborted) this.#abort();
  }
  #abort = () => {
    const reason = this.signal.reason ?? new Error("Channel activation aborted.");
    this.#initialized.reject(reason);
    this.#ready.reject(reason);
  };
  #check(): void {
    this.signal.throwIfAborted();
    if (this.#disposed || !this.current() || this.context.peer.closed)
      throw new Error("Channel owner is no longer current.");
  }
  async #wait(work: Promise<void>): Promise<void> {
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(this.signal.reason ?? new Error("Channel activation aborted."));
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) abort();
    });
    try {
      await Promise.race([work, cancelled, this.#disposal.promise]);
      this.#check();
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }
  afterInitialize(): Promise<void> {
    if (!this.#run) {
      const completion = phaseDeferred<void>();
      this.#run = completion.promise;
      void this.#advance().then(completion.resolve, completion.reject);
    }
    return this.#run;
  }
  async #advance(): Promise<void> {
    try {
      this.#check();
      this.#initialized.resolve(this.context);
      await this.#wait(this.binding.initialized(this.signal));
      this.#check();
      await this.#wait(this.binding.ready(this.signal));
      this.#ready.resolve();
    } catch (error) {
      this.#initialized.reject(error);
      this.#ready.reject(error);
      throw error;
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.signal.removeEventListener("abort", this.#abort);
    const error = new Error("Channel disposed.");
    this.#disposal.reject(error);
    this.#initialized.reject(error);
    this.#ready.reject(error);
    this.binding.dispose();
  }
}

import type {
  FoundationDiagnostics,
  FoundationCounters,
  FoundationDiagnosticEvent,
} from "./ui-host-ports.js";
const runtimeDiagnostics = new WeakMap<object, FoundationDiagnostics>();
/** Internal registration for the manager-owned attachment; never exported from the barrel. */
export function registerRuntimeDiagnostics(
  instance: UiRuntimeAttachment,
  owners: () => number,
  timers: () => number,
): void {
  const listeners = new Set<(event: FoundationDiagnosticEvent) => void>();
  runtimeDiagnostics.set(
    instance,
    Object.freeze({
      snapshot: (): FoundationCounters =>
        Object.freeze({
          owners: owners(),
          timers: timers(),
          bindings: 0,
          subscriptions: 0,
          queuedEvents: 0,
          queuedBytes: 0,
          pendingInvocations: 0,
          actionTokens: 0,
          resourceReaders: 0,
          workerJobs: 0,
        }),
      onEvent: (listener: (event: FoundationDiagnosticEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    }),
  );
}
export function diagnosticsFor(instance: object): FoundationDiagnostics {
  const diagnostics = runtimeDiagnostics.get(instance);
  if (!diagnostics) throw new Error("Unknown runtime attachment.");
  return diagnostics;
}
