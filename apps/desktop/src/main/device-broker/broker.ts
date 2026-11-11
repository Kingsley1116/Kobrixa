import { journalDocument } from "./journal.js";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
  channelDefinitionSchema,
  deviceRequestSchemasV180 as deviceRequestSchemas,
  validDeviceResultV180,
  validateConnectionRecoverySnapshot,
  type ConnectionRecovery,
  type ConnectionRecoverySnapshot,
  sourceCatalogSchema,
  telemetryFrameSchema,
  validateDeviceWire,
  RpcError,
  RPC_ERRORS,
  type DeviceMethodV180 as DeviceMethod,
  type DeviceParamsV180 as DeviceParams,
  type DeviceResultV180 as DeviceResult,
  type DeviceSessionSnapshot,
  type SourceCatalog,
  type DeviceCandidate,
  type DeviceSubscriptionParamsV180 as DeviceSubscriptionParams,
  type DeviceSubscriptionSnapshotV180 as DeviceSubscriptionSnapshot,
  type Permission,
  type ResourceOwner,
  type AuthoritySnapshot,
} from "@kobrixa/plugin-protocol";
import type {
  Principal,
  JournalOwner,
  DeviceDisposition,
  SessionQuiescence,
  SafetyFaultEntry,
  OperationClass,
  Stage3EventEnvelope,
  Stage3Event,
} from "@kobrixa/plugin-runtime";
import type {
  CoreTelemetrySubscription,
  DeviceBrokerOptions,
  DeviceBrokerPort,
  LegacyOperationPort,
  LegacyOperation,
} from "./broker-port.js";
import {
  ExchangeLane,
  createContexts,
  type ProviderCandidate,
  type ProviderConnection,
  type ProviderCatalogPort,
  type BuiltinDeviceProvider,
  type ProviderOutcome,
  type LegacyProviderValue,
} from "./provider.js";
import {
  ProviderRegistry,
  OwnerLedger,
  EventLedger,
  ownerKey,
  resourceOwnerKey,
  BrokerFailure,
  deviceFailure,
  stale,
  quota,
} from "./registry.js";
import { IntentRegistry } from "./intent.js";
import { OperationStore, type MotionAdmission } from "./operations.js";
import { Sampler, CoreTelemetryLedger } from "./sampler.js";
import { Reservations } from "./reservations.js";
import type { createDeviceRecovery, RecoveryDriver } from "./recovery-port.js";
import { isIdle, samePhysical } from "./recovery-port.js";
import type { createDeviceResourceParticipant, ResourceDriver } from "./resource-participant.js";
import { settleProviderRetirementLifecycle } from "./resource-participant.js";
import { ProviderRetirementBlocked } from "./broker-port.js";
export type BrokerLifecycleEvent =
  | { kind: "lost"; session: DeviceSessionSnapshot; message: string }
  | {
      kind: "recovery";
      previousSessionId: string;
      state: "waiting" | "connecting" | "restored" | "cancelled" | "unavailable" | "exhausted";
      session?: DeviceSessionSnapshot;
    };
const lifecycleListeners = new WeakMap<
  DeviceBrokerPort,
  Set<(event: BrokerLifecycleEvent) => void>
>();
export type BrokerSessionCatalog = {
  hostEpoch: string;
  revision: number;
  cause: "snapshot" | "changed" | "connected" | "recovered" | "lost";
  origin: "core" | "plugin" | "recovery";
  session: DeviceSessionSnapshot | null;
};
const sessionCatalogs = new WeakMap<
  DeviceBrokerPort,
  {
    read(): BrokerSessionCatalog;
    listeners: Set<(snapshot: BrokerSessionCatalog) => void>;
  }
>();
/** Main-only, read-only projection. Does not acquire a principal, owner, sampler or native handle. */
export function readBrokerSessionCatalog(
  broker: DeviceBrokerPort,
): BrokerSessionCatalog | undefined {
  return sessionCatalogs.get(broker)?.read();
}
export function observeBrokerSessions(
  broker: DeviceBrokerPort,
  listener: (snapshot: BrokerSessionCatalog) => void,
): () => void {
  const entry = sessionCatalogs.get(broker);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  try {
    listener(entry.read());
  } catch {
    entry.listeners.delete(listener);
    throw new Error("Session observer failed.");
  }
  return () => {
    entry.listeners.delete(listener);
  };
}
const recoverySessions = new WeakMap<DeviceBrokerPort, () => DeviceSessionSnapshot[]>();
/** Main-only recovery observation; never grants session ownership or starts device work. */
export function readDeviceRecoverySessions(broker: DeviceBrokerPort): DeviceSessionSnapshot[] {
  const read = recoverySessions.get(broker);
  if (!read) throw new Error("Device recovery observation is unavailable.");
  return read();
}
export function observeBrokerLifecycle(
  broker: DeviceBrokerPort,
  listener: (event: BrokerLifecycleEvent) => void,
): () => void {
  const listeners = lifecycleListeners.get(broker);
  listeners?.add(listener);
  return () => {
    listeners?.delete(listener);
  };
}
// Main-only observations leave the frozen provider/session ports unchanged.
// Only the broker that created a port can register its live observation state.
type SourceTuple = Parameters<ProviderCatalogPort["identify"]>[0];
type SourceObservation = {
  sessionId: string;
  generation: number;
  signature: string;
  ids: Map<string, string>;
};
type CatalogBinding = {
  generation: number | null;
  retired: boolean;
  ids: Map<string, string>;
  observation: SourceObservation | null;
};
const catalogObservers = new WeakMap<
  ProviderCatalogPort,
  (sessionId: string, tuples: readonly SourceTuple[]) => void
>();
export function observeProviderSources(
  port: ProviderCatalogPort,
  sessionId: string,
  tuples: readonly SourceTuple[],
): void {
  catalogObservers.get(port)?.(sessionId, tuples);
}
type ResumeState = "resumed" | "pending" | "blocked";
const resumeObservers = new WeakMap<
  DeviceBrokerPort["sessions"],
  (receipt: SessionQuiescence) => ResumeState
>();
export function resumeQuiescedSession(
  port: DeviceBrokerPort["sessions"],
  receipt: SessionQuiescence,
): ResumeState {
  port.resume(receipt.sessionId);
  // Non-broker ports keep their existing synchronous void completion contract.
  return resumeObservers.get(port)?.(receipt) ?? "resumed";
}
const legacyAdmissions = new WeakMap<LegacyOperation, () => void>();
/** Consume the host file plan's confirmation without adding a plugin wire method. */
export function admitLegacyExecution(operation: LegacyOperation): void {
  legacyAdmissions.get(operation)?.();
}
// Host-only closure observation keeps the frozen wire and telemetry port unchanged.
const coreClosures = new WeakMap<
  CoreTelemetrySubscription,
  { ended: boolean; listeners: Set<() => void> }
>();
export function observeCoreTelemetryClosed(
  subscription: CoreTelemetrySubscription,
  listener: () => void,
): () => void {
  const state = coreClosures.get(subscription);
  if (state?.ended) listener();
  else state?.listeners.add(listener);
  return () => {
    state?.listeners.delete(listener);
  };
}
type Options = DeviceBrokerOptions;
type Session = {
  /** Storage may outlive an already-ended reservation. */
  hadReservations: boolean;
  initialization?: Promise<void>;
  connectionClosed?: boolean;
  recoveryDisposition?: Promise<DeviceDisposition>;
  recoveryClosed?: boolean;
  recoveryHistory: Array<{
    sequence: number;
    owner: string;
    settled: Promise<DeviceDisposition>;
    faultIds?: readonly string[];
  }>;
  recoveryProofs: Map<
    string,
    { sequence: number; valid(): boolean; covers(owner: string): boolean }
  >;
  originalDisposition?: Promise<DeviceDisposition[]>;
  providerPending: Set<Promise<unknown>>;
  snapshot: DeviceSessionSnapshot;
  sources: SourceCatalog;
  connection: ProviderConnection;
  provider: BuiltinDeviceProvider;
  generation: number;
  lane: ExchangeLane;
  sampler: Sampler;
  quiescence: SessionQuiescence | null;
  suspendOnly: boolean;
  resumeEvidence?: {
    receipt: SessionQuiescence;
    disposition: DeviceDisposition;
    recovery: Session["recoveryDisposition"];
  };
  users: Set<string>;
  unregister: () => void;
};
type ConnectionCustody = {
  generation: number;
  closed: boolean;
  attempted: boolean;
  close(): Promise<boolean>;
};
type Candidate = {
  candidate: ProviderCandidate;
  generation: number;
  expires: number;
  recoveryCapture?: (custody: ConnectionCustody) => void;
  recoveryCheck?: () => void;
  recoveryAdopt?: (snapshot: DeviceSessionSnapshot) => void;
};
const merge = async (promises: Promise<DeviceDisposition>[]): Promise<DeviceDisposition> => {
  const all = await Promise.all(promises);
  return {
    stopConfirmed: all.every((v) => v.stopConfirmed),
    journalCommitted: all.every((v) => v.journalCommitted),
    faultIds: [...new Set(all.flatMap((v) => v.faultIds))],
  };
};
// The first quiescence keeps its identity and original operation receipts. New
// explicit recovery can add evidence, but never restarts those operations/clocks.
async function settleRecovery(
  current: Session,
  original: Promise<DeviceDisposition[]>,
  close = false,
  observe?: (disposition: DeviceDisposition, recovery: Session["recoveryDisposition"]) => void,
): Promise<DeviceDisposition> {
  for (;;) {
    const recovery = current.recoveryDisposition;
    const history = [...current.recoveryHistory];
    const originals = await original;
    const receipts = [
      ...originals.map((value) => ({ sequence: 0, value })),
      ...(await Promise.all(
        history.map(async (row) => ({
          sequence: row.sequence,
          value: await row.settled,
        })),
      )),
    ];
    if (recovery !== current.recoveryDisposition) continue;
    // Supersede each obligation separately: a no-fault failure cannot borrow
    // another receipt's fault IDs. Original receipts and deadlines never change.
    const effective = receipts.map(({ sequence, value }) => {
      if (
        !value.faultIds.length ||
        !value.faultIds.every((id) => {
          const proof = current.recoveryProofs.get(id);
          return proof && proof.sequence > sequence && proof.valid();
        })
      )
        return value;
      return { stopConfirmed: true, journalCommitted: true, faultIds: [] };
    });
    const disposition = {
      stopConfirmed: effective.every((value) => value.stopConfirmed),
      journalCommitted: effective.every((value) => value.journalCommitted),
      faultIds: [...new Set(effective.flatMap((value) => value.faultIds))],
    };
    // Every quarantining owner needs its own fault-bound proof. In particular,
    // an unrelated journal fault cannot cover a passive transport timeout.
    if (
      current.lane.quarantined &&
      !current.lane.quarantineOwners.every(
        (owner) =>
          owner !== null &&
          [...current.recoveryProofs.values()].some(
            (proof) => proof.covers(owner) && proof.valid(),
          ),
      )
    )
      disposition.stopConfirmed = false;
    if (
      disposition.faultIds.length ||
      (close && (current.lane.occupied || current.providerPending.size))
    )
      disposition.stopConfirmed = false;
    if (close && disposition.stopConfirmed && disposition.journalCommitted)
      current.recoveryClosed = true;
    observe?.(disposition, recovery);
    return disposition;
  }
}
/** Track the actual provider promises, including work outliving a caller timeout.
 * A transport drain alone cannot prove that an old provider continuation ended. */
function trackedProvider(provider: BuiltinDeviceProvider, pending: Set<Promise<unknown>>) {
  return new Proxy(provider, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        if (result instanceof Promise) {
          pending.add(result);
          void result.then(
            () => pending.delete(result),
            () => pending.delete(result),
          );
        }
        return result;
      };
    },
  });
}
const permissionFailure = (): never => {
  throw new BrokerFailure({
    ok: false,
    error: {
      code: "PLUGIN_E_PERMISSION_DENIED",
      message: "Permission required.",
      detail: { kind: "permission", reason: "permission" },
    },
  });
};
const actionFailure = (): never => {
  throw new BrokerFailure({
    ok: false,
    error: {
      code: "PLUGIN_E_PERMISSION_DENIED",
      message: "User action required.",
      detail: { kind: "permission", reason: "user-action-required" },
    },
  });
};
function value<T>(outcome: ProviderOutcome<T>): T {
  if (outcome.error || outcome.value === null)
    return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-failure", outcome.dispatch);
  return outcome.value;
}
export function createBroker(
  input: Options,
  factories: {
    recovery: typeof createDeviceRecovery;
    participant: typeof createDeviceResourceParticipant;
  },
): DeviceBrokerPort & LegacyOperationPort {
  const heldProviders = new Map<number, string>();
  const providerHeld = (id: string) => [...heldProviders.values()].includes(id);
  const getProvider = (id: string) => {
    if (providerHeld(id)) return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "provider-disabled");
    return providers.get(id);
  };
  const providerWork = new Map<number, Set<Promise<unknown>>>();
  const trackProviderWork = <T>(generation: number, work: Promise<T>): Promise<T> => {
    const pending = providerWork.get(generation) ?? new Set<Promise<unknown>>();
    providerWork.set(generation, pending);
    pending.add(work);
    const done = () => {
      pending.delete(work);
      if (!pending.size) providerWork.delete(generation);
    };
    void work.then(done, done);
    return work;
  };
  const wallNow = () => Date.now(); // Broker has no injected wall clock; recovery determinism is pinned through RecoveryDriver.wallNow test doubles.
  input.profile.assertHeld();
  const lifecycle = new Set<(event: BrokerLifecycleEvent) => void>();
  const notifyLifecycle = (event: BrokerLifecycleEvent) => {
    for (const listener of [...lifecycle]) {
      try {
        listener(structuredClone(event));
      } catch {
        /* Observers cannot block safety cleanup. */
      }
    }
  };
  const recoveryState = (
    previousSessionId: string,
    state: Extract<BrokerLifecycleEvent, { kind: "recovery" }>["state"],
    restored?: DeviceSessionSnapshot,
  ) =>
    notifyLifecycle({
      kind: "recovery",
      previousSessionId,
      state,
      ...(restored ? { session: restored } : {}),
    });
  const providers = new ProviderRegistry(),
    candidates = new OwnerLedger<Candidate>(64, 64, "candidate"),
    subscriptions = new Map<
      string,
      {
        owner: ResourceOwner;
        params: DeviceSubscriptionParams;
        notify: (sourcesChanged?: boolean) => void;
        dispose: () => void;
      }
    >(),
    reservations = new Reservations(input.now),
    coreReservations = new Reservations<Extract<JournalOwner, { kind: "core" }>>(input.now),
    retired = new Set<string>();
  let session: Session | null = null,
    connecting = false,
    closing = false,
    revision = 0;
  const connectionLane = new ExchangeLane(input.now);
  let retainedConnection: ConnectionCustody | null = null;
  const coreTelemetry = new CoreTelemetryLedger(input.now);
  let catalogRevision = 0;
  let sessionOrigin: BrokerSessionCatalog["origin"] = "core";
  const sessionObservers = new Set<(snapshot: BrokerSessionCatalog) => void>();
  const sessionCatalog = (
    cause: BrokerSessionCatalog["cause"] = "snapshot",
  ): BrokerSessionCatalog => ({
    hostEpoch: input.profile.hostEpoch,
    revision: catalogRevision,
    cause,
    origin: sessionOrigin,
    session: session && !session.initialization ? sessionSnapshot(session) : null,
  });
  let publishedSession: string | undefined = JSON.stringify(null);
  const changed = (sourcesChanged = false, cause: BrokerSessionCatalog["cause"] = "changed") => {
    catalogRevision++;
    // Synchronous publication updates host adapters before any power/window callback.
    const snapshot = sessionCatalog(cause);
    const identity = JSON.stringify(snapshot.session);
    // Discovery/provider catalog churn is not a disconnected session transition.
    if (cause !== "changed" || identity !== publishedSession) {
      publishedSession = identity;
      for (const listener of [...sessionObservers])
        try {
          listener(structuredClone(snapshot));
        } catch {
          /* Observers never block cleanup. */
        }
    }
    for (const row of [...subscriptions.values()])
      if (row.params.topic === "catalog" || row.params.topic === "session")
        row.notify(sourcesChanged);
  };
  const attemptPolicies = new Map<string, ReturnType<Options["connectionPolicy"]>>();
  type Episode = {
    principal: Principal;
    providerId: string;
    generation: number;
    digest: string;
    settled: Promise<DeviceDisposition>;
    policy: ReturnType<Options["connectionPolicy"]>;
    attempts: number;
    timer: ReturnType<typeof setTimeout> | null;
    pending: boolean;
    control: AbortController;
    ref: {
      recoveryId: string;
      providerId: string;
      providerGeneration: number;
      previousSessionId: string;
    };
    name: string;
    due: number;
    done: Promise<void>;
    custody?: ConnectionCustody;
    cancelDeadline?: number;
    cancellation?: Promise<void>;
  };
  const lostUsb = new Map<string, Episode>();
  let latestEpisode: Episode | null = null;
  let projection: ConnectionRecovery | null = null;
  let recoveryRevision = 0;
  type Phase = ConnectionRecovery extends infer T
    ? T extends ConnectionRecovery
      ? Omit<
          T,
          | "recoveryId"
          | "providerId"
          | "providerGeneration"
          | "previousSessionId"
          | "name"
          | "attemptsStarted"
          | "retryLimit"
        >
      : never
    : never;
  const recoverySnapshot = (): ConnectionRecoverySnapshot =>
    validateConnectionRecoverySnapshot({
      hostEpoch: input.profile.hostEpoch,
      revision: recoveryRevision,
      recovery:
        projection?.phase === "waiting" && latestEpisode
          ? {
              ...projection,
              retryAfterMs: Math.max(
                0,
                Math.min(10000, Math.ceil(latestEpisode.due - input.now())),
              ),
            }
          : projection,
    });
  const publishRecovery = (row: Episode, phase: Phase) => {
    if (latestEpisode !== row) return;
    const next = {
      ...row.ref,
      name: row.name,
      attemptsStarted: row.attempts,
      retryLimit: row.policy.usbRetryLimit,
      ...phase,
    } as ConnectionRecovery;
    validateConnectionRecoverySnapshot({
      hostEpoch: input.profile.hostEpoch,
      revision: recoveryRevision + 1,
      recovery: next,
    });
    projection = next;
    recoveryRevision++;
    for (const sub of [...subscriptions.values()])
      if (sub.params.topic === "connectionRecovery") sub.notify();
  };
  const clearRecovery = () => {
    latestEpisode = null;
    projection = null;
    recoveryRevision++;
    for (const sub of [...subscriptions.values()])
      if (sub.params.topic === "connectionRecovery") sub.notify();
  };
  const revokeEpisode = (row: Episode) => {
    if (row.timer) clearTimeout(row.timer);
    row.timer = null;
    lostUsb.delete(row.ref.previousSessionId);
    row.cancelDeadline ??= input.now() + 15000;
    row.control.abort();
  };
  const cancelEpisode = (
    row: Episode,
    reason: Extract<ConnectionRecovery, { phase: "cancelled" }>["reason"],
  ): Promise<void> => {
    if (row.cancellation) return row.cancellation;
    const retry = projection?.phase === "cancel-failed";
    // Keep both the original pending attempt and its cleanup context. A timeout
    // publishes uncertainty, and cannot free the connection lane or mint a grant.
    // Install the joinable operation before publishing to synchronous observers.
    row.cancellation = Promise.resolve()
      .then(async () => {
        let confirmed = false;
        try {
          if (row.pending) await bounded(row.done, Math.max(0, row.cancelDeadline! - input.now()));
          confirmed =
            !row.pending &&
            (!row.custody ||
              row.custody.closed ||
              ((!row.custody.attempted || retry) && (await row.custody.close())));
        } catch {
          /* The exact retained attempt is still unresolved. */
        }
        publishRecovery(
          row,
          confirmed
            ? { phase: "cancelled", reason }
            : {
                phase: "cancel-failed",
                error: {
                  reason: row.pending ? "cleanup-pending" : "cleanup-failed",
                  message: row.pending
                    ? "The original connection attempt is still settling."
                    : "The original connection cleanup is unconfirmed.",
                },
              },
        );
      })
      .finally(() => {
        delete row.cancellation;
      });
    revokeEpisode(row);
    publishRecovery(row, { phase: "cancelling" });
    return row.cancellation;
  };
  const forgetUsb = (
    id: string,
    state: "cancelled" | "exhausted" | "unavailable" | null = "cancelled",
    reason: Extract<ConnectionRecovery, { phase: "cancelled" }>["reason"] = "authority-lost",
  ) => {
    const row = lostUsb.get(id);
    if (!row) return;
    if (row.timer) clearTimeout(row.timer);
    row.timer = null;
    lostUsb.delete(id);
    if (state === "cancelled" || state === "unavailable") void cancelEpisode(row, reason);
    else {
      row.control.abort();
      if (state === "exhausted") publishRecovery(row, { phase: "retry-exhausted" });
    }
    if (state) recoveryState(id, state);
  };
  const readRecoveryPolicy = (row: Episode) => {
    try {
      return Object.freeze({ ...input.connectionPolicy() });
    } catch {
      // The last admitted policy may describe this episode, but cannot grant
      // another discovery/connect continuation while authoritative storage is unavailable.
      forgetUsb(row.ref.previousSessionId, "cancelled", "policy");
      return null;
    }
  };
  const usbLive = (row: NonNullable<ReturnType<typeof lostUsb.get>>) => {
    if (closing) return false;
    const policy = readRecoveryPolicy(row);
    if (!policy) return false;
    if (!policy.usbAutoReconnect) {
      forgetUsb(row.ref.previousSessionId, "cancelled", "policy");
      return false;
    }
    try {
      assertPrincipal(row.principal);
      const registration = getProvider(row.providerId);
      if (registration.generation !== row.generation) return false;
      const ref = row.principal.authorityContext?.ref;
      const context = ref ? input.authority.current(row.principal, ref) : null;
      if (
        !context ||
        context.state === "invalid" ||
        context.epoch !== row.principal.authorityContext?.epoch
      )
        return false;
      permission(row.principal, "devices.connect");
      input.authority.assertContinuation(row.principal, ref!);
      gate(row.principal, "connection", null, "admission");
      return true;
    } catch {
      return false;
    }
  };
  const scheduleUsb = (id: string) => {
    const row = lostUsb.get(id);
    if (!row || row.timer || row.pending) return;
    const policy = readRecoveryPolicy(row);
    if (!policy) return;
    row.policy = policy;
    if (!row.policy.usbAutoReconnect || !usbLive(row)) {
      const initial = row.attempts === 0;
      forgetUsb(
        id,
        initial ? "unavailable" : "cancelled",
        !row.policy.usbAutoReconnect ? "policy" : "authority-lost",
      );
      return;
    }
    if (policy.usbRetryLimit !== "unlimited" && row.attempts >= policy.usbRetryLimit) {
      forgetUsb(id, "exhausted");
      return;
    }
    const delay =
      policy.usbRetryInterval === "backoff"
        ? [1000, 2000, 5000][Math.min(row.attempts, 2)]!
        : policy.usbRetryInterval;
    row.due = input.now() + delay;
    publishRecovery(row, { phase: "waiting", retryAfterMs: delay });
    if (row.attempts === 0) recoveryState(id, "waiting");
    row.timer = setTimeout(() => {
      row.timer = null;
      if (!usbLive(row)) {
        forgetUsb(id);
        return;
      }
      void broker
        .reconnectForRecovery({ previousSessionId: id, signal: new AbortController().signal })
        .then(
          () => scheduleUsb(id),
          () => {
            // Unexpected provider errors must not leave a live retry or an
            // unobserved rejection. The original episode stays unavailable.
            if (lostUsb.get(id) !== row) return;
            forgetUsb(id, null);
            publishRecovery(row, { phase: "manual-required", reason: "cleanup-required" });
            recoveryState(id, "unavailable");
          },
        );
    }, delay);
    row.timer.unref();
  };
  const samplerPrincipal: Principal = {
    kind: "core",
    adapter: "monitor",
    hostEpoch: input.profile.hostEpoch,
    workbenchInstance: randomUUID(),
    authorityContext: null,
  };
  const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Provider deadline")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const legacy = new Map<
    string,
    {
      principal: Principal;
      session: string;
      operationClass: "file-read" | "file-write" | "deployment" | "program-launch";
      cancel: () => Promise<void>;
      done: Promise<DeviceDisposition>;
    }
  >();
  const assertPrincipal = (principal: Principal) => {
    input.profile.assertHeld();
    if (
      principal.kind === "plugin" &&
      (principal.owner.hostEpoch !== input.profile.hostEpoch ||
        retired.has(resourceOwnerKey(principal.owner)))
    )
      return stale();
    if (closing) return deviceFailure("PLUGIN_E_SHUTTING_DOWN", "shutting-down");
  };
  const permission = (principal: Principal, required: Permission) => {
    if (!input.hasPermission(principal, required)) permissionFailure();
  };
  const getSession = (principal: Principal, id: string, admission = true): Session => {
    const current = session;
    if (!current || current.snapshot.sessionId !== id) return stale();
    // A real host binding may act on a public session after current authority
    // validation. Observation itself never enrolls an owner or grants I/O.
    if (
      !current.users.has(ownerKey(principal)) &&
      (principal.kind !== "core" || !validCore(principal, current))
    )
      return stale();
    if (admission) {
      assertPrincipal(principal);
      getProvider(current.provider.id);
      if (current.quiescence) return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "disconnected");
      if (current.snapshot.state !== "connected" || current.lane.quarantined)
        return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "quarantined");
    }
    return current;
  };
  const validCore = (principal: Extract<Principal, { kind: "core" }>, current: Session) => {
    const ref = principal.authorityContext?.ref;
    const context = ref ? input.authority.current(principal, ref) : null;
    return (
      !closing &&
      !providerHeld(current.provider.id) &&
      session === current &&
      !current.quiescence &&
      principal.hostEpoch === input.profile.hostEpoch &&
      !!context &&
      context.state !== "invalid" &&
      context.epoch === principal.authorityContext?.epoch &&
      context.workbenchInstance === principal.workbenchInstance
    );
  };
  const checkCore = (principal: Extract<Principal, { kind: "core" }>, current: Session) => {
    assertPrincipal(principal);
    if (!validCore(principal, current)) return stale("reservation");
  };
  const gate = (
    principal: Principal,
    operationClass: OperationClass,
    sessionId: string | null,
    phase: "admission" | "continuation",
  ) => {
    const result = input.operationGate({ principal, operationClass, sessionId, phase });
    if (!result.ok) throw new BrokerFailure(result);
  };
  const operations = new OperationStore({
    now: input.now,
    profile: input.profile,
    journal: input.journal,
    check: (admission: MotionAdmission) => {
      const current = getSession(admission.principal, admission.sessionId);
      permission(admission.principal, "devices.control");
      ensureCapability(current, "finiteMotion.v1");
      if (current.generation !== admission.generation || current.connection.key !== admission.key)
        return stale();
      if (reservations.active || coreReservations.active)
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "recording");
      gate(admission.principal, "finite-motion", admission.sessionId, "continuation");
      input.authority.assertContinuation(admission.principal, admission.contextRef);
      if (admission.principal.kind !== "plugin")
        return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "ui-scope-unavailable");
      intent.assert(
        admission.principal.owner,
        admission.motionScopeRef,
        admission.contextRef,
        admission.gestureRef,
      );
    },
  });
  const intentOwners = new Map<string, ResourceOwner>();
  const intent = new IntentRegistry(input.now, (scope) => operations.stopScope(scope));
  const channels = new Map<
    string,
    {
      owner: ResourceOwner;
      principal: () => Principal;
      send: (event: Stage3EventEnvelope) => void;
      domains: Set<"devices" | "ui" | "settings">;
      retire: () => void;
    }
  >();
  const events = new EventLedger(
    input.now,
    (event) => {
      const channel = channels.get(resourceOwnerKey(event.owner));
      if (!channel) return stale("subscription");
      const current = channel.principal();
      if (
        current.kind !== "plugin" ||
        resourceOwnerKey(current.owner) !== resourceOwnerKey(event.owner) ||
        retired.has(resourceOwnerKey(event.owner))
      )
        return stale("subscription");
      const domain = event.kind.startsWith("ui.")
        ? "ui"
        : event.kind.startsWith("settings.")
          ? "settings"
          : event.kind.startsWith("devices.")
            ? "devices"
            : null;
      if (domain && !channel.domains.has(domain)) return stale("subscription");
      try {
        channel.send(event);
      } catch (error) {
        channel.retire();
        throw error;
      }
    },
    (owner) => {
      intent.retire(owner);
      operations.stopOwner(owner);
    },
  );
  events.onRemoved((id) => {
    subscriptions.get(id)?.dispose();
    subscriptions.delete(id);
  });
  const contexts = (
    principal: Principal,
    current: Session | null,
    operationClass: Parameters<typeof createContexts>[0]["operationClass"],
    duration: number,
    id = randomUUID(),
    validate: () => void = () => {},
    rearmMs?: number,
    generation = current?.generation ?? 0,
  ) =>
    createContexts({
      id,
      sessionId: current?.snapshot.sessionId ?? null,
      generation,
      operationClass,
      deadline: input.now() + duration,
      ...(rearmMs === undefined ? {} : { rearmMs }),
      now: input.now,
      lane: current?.lane ?? connectionLane,
      check: () => {
        assertPrincipal(principal);
        validate();
        if (current) {
          getSession(principal, current.snapshot.sessionId);
          getProvider(current.provider.id);
          ensureCapability(
            current,
            operationClass === "mode-write" || operationClass === "mode-read"
              ? "inputModes.v1"
              : operationClass === "passive-read"
                ? "telemetry.v1"
                : "connection.v1",
          );
        }
        if (operationClass !== "passive-read" && operationClass !== "mode-read")
          gate(principal, operationClass, current?.snapshot.sessionId ?? null, "continuation");
        if (
          ["connection", "mode-write", "file-write", "deployment", "program-launch"].includes(
            operationClass,
          )
        ) {
          permission(
            principal,
            operationClass === "connection" ? "devices.connect" : "devices.control",
          );
          if (!principal.authorityContext)
            return deviceFailure("PLUGIN_E_DEVICE_AUTHORITY", "unbound");
          input.authority.assertContinuation(principal, principal.authorityContext.ref);
        }
      },
      progress: () => {},
      onStop: () => {},
    });
  const publishSources = (current: Session, raw: SourceCatalog) => {
    const sources = sourceCatalogSchema.parse(raw);
    if (
      session !== current ||
      sources.sessionId !== current.snapshot.sessionId ||
      sources.sourceRevision < current.sources.sourceRevision
    )
      return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-contract");
    if (sources.sourceRevision !== current.sources.sourceRevision) {
      // End pinned recordings before any frame with replacement source identities
      // is published. Consumers fetch the complete retained catalog on control.
      reservations.endSession(current.snapshot.sessionId, "source-changed", true);
      coreReservations.endSession(current.snapshot.sessionId, "source-changed", true);
      current.sources = sources;
      current.snapshot.sourceRevision = sources.sourceRevision;
      current.snapshot.revision++;
      changed(true);
    }
  };
  const makeSampler = (id: string, lane: ExchangeLane, get: () => Session, previous?: Sampler) => {
    const sampler =
      previous?.restart() ??
      new Sampler({
        sessionId: id,
        now: input.now,
        busy: () => lane.foreground !== null,
        read: async () => {
          const current = get(),
            ctx = contexts(samplerPrincipal, current, "passive-read", 10000);
          const frame = telemetryFrameSchema.parse(
            value(await current.provider.read(current.connection.key, ctx.work)),
          );
          ctx.work.assertContinuation("read");
          if (frame.sourceRevision !== current.sources.sourceRevision) {
            const sources = value(await current.provider.sources(current.connection.key, ctx.work));
            ctx.work.assertContinuation("read");
            publishSources(current, sources);
            // A second physical change during catalog reconciliation is not a usable
            // sample. The next explicit read can sample the newly retained sources.
            if (frame.sourceRevision !== current.sources.sourceRevision)
              return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "source-changed");
          }
          return frame;
        },
      });
    sampler.subscribe((frame) => {
      reservations.append(frame);
      coreReservations.append(frame);
    });
    return sampler;
  };
  const finishSession = (
    current: Session,
    reason: "disconnected" | "suspended" | "core-disconnect",
    recoveryFollows = false,
  ) => {
    current.suspendOnly = reason === "suspended";
    delete current.resumeEvidence;
    current.snapshot.state = reason === "disconnected" ? "disconnected" : "disconnecting";
    current.snapshot.revision++;
    current.sampler.dispose();
    coreTelemetry.dispose();
    for (const [id, row] of [...subscriptions])
      if (row.params.topic === "telemetry" && row.params.sessionId === current.snapshot.sessionId)
        events.unsubscribe(row.owner, id);
    for (const owner of intentOwners.values()) intent.retire(owner);
    intentOwners.clear();
    if (reason === "disconnected")
      notifyLifecycle({
        kind: "lost",
        session: current.snapshot,
        message: "The EV3 connection was lost.",
      });
    if (reason === "disconnected" && current.snapshot.transport === "usb" && !recoveryFollows)
      recoveryState(current.snapshot.sessionId, "unavailable");
    changed(false, reason === "disconnected" ? "lost" : "changed");
    coreReservations.endSession(current.snapshot.sessionId, reason, true);
    const ended = reservations.endSession(current.snapshot.sessionId, reason, true);
    const promises = operations.stopSession(current.snapshot.sessionId);
    // Passive I/O also has to cross its original boundary before a wake can
    // admit a fresh sampler. A timed-out lane remains quarantined.
    const deadline = input.now() + 15000;
    promises.push(
      Promise.all([current.lane.drain(deadline), current.sampler.settled(deadline)]).then(
        () => ({ stopConfirmed: true, journalCommitted: true, faultIds: [] }),
        () => ({ stopConfirmed: false, journalCommitted: true, faultIds: [] }),
      ),
    );
    for (const operation of legacy.values())
      if (operation.session === current.snapshot.sessionId) {
        void operation.cancel();
        promises.push(operation.done);
      }
    const original = Promise.all(promises);
    current.originalDisposition = original;
    const receipt: SessionQuiescence = {
      sessionId: current.snapshot.sessionId,
      ended,
      get settled() {
        return settleRecovery(current, original, false, (disposition, recovery) => {
          if (current.quiescence === receipt)
            current.resumeEvidence = { receipt, disposition, recovery };
        });
      },
    };
    return receipt;
  };
  const sessions: DeviceBrokerPort["sessions"] = {
    quiesce(id, cause) {
      const current = session;
      if (!current || current.snapshot.sessionId !== id) return stale();
      if (cause.reason === "core-disconnect") forgetUsb(id);
      if (
        cause.reason === "core-disconnect" &&
        !input.coreActions.isClaimed(cause.action, { kind: "device-disconnect", sessionId: id }) &&
        !input.coreActions.claim(cause.action, { kind: "device-disconnect", sessionId: id })
      )
        actionFailure();
      if (!current.quiescence) current.quiescence = finishSession(current, cause.reason);
      if (cause.reason !== "suspended") current.suspendOnly = false;
      return current.quiescence;
    },
    async disconnect(id, action) {
      try {
        const current = session;
        if (!current || current.snapshot.sessionId !== id) return stale();
        if (!input.coreActions.isClaimed(action, { kind: "device-disconnect", sessionId: id }))
          actionFailure();
        const quiescence = current.quiescence;
        if (!quiescence) return actionFailure();
        current.suspendOnly = false;
        const disposition = await settleRecovery(current, current.originalDisposition!, true);
        if (!disposition.stopConfirmed || !disposition.journalCommitted)
          return deviceFailure("PLUGIN_E_DEVICE_STOP_UNCONFIRMED", "readback-failed", "unknown");
        const core: Principal = {
          kind: "core",
          adapter: "recovery",
          hostEpoch: input.profile.hostEpoch,
          workbenchInstance: action.scope.workbenchInstance,
          authorityContext: null,
        };
        const ctx = contexts(core, current, "connection", 60000);
        await current.lane.drain(input.now() + 15000);
        const result = await current.provider.disconnect(current.connection.key, ctx.cleanup);
        if (result.error)
          return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-failure", result.dispatch);
        current.snapshot.state = "disconnected";
        current.unregister();
        session = null;
        revision++;
        changed();
        return { ok: true, value: { sessionId: id, disconnected: true } };
      } catch (error) {
        if (error instanceof BrokerFailure) return error.result;
        throw error;
      }
    },
    resume(id) {
      const current = session,
        evidence = current?.resumeEvidence;
      if (
        !current ||
        current.snapshot.sessionId !== id ||
        closing ||
        !current.suspendOnly ||
        !evidence ||
        evidence.receipt !== current.quiescence ||
        evidence.recovery !== current.recoveryDisposition ||
        !evidence.disposition.stopConfirmed ||
        !evidence.disposition.journalCommitted ||
        evidence.disposition.faultIds.length ||
        current.lane.quarantined ||
        current.lane.occupied ||
        current.providerPending.size ||
        current.lane.foreground !== null
      )
        return;
      const journal = input.journal.snapshot();
      if (journal.journalHealth !== "ready" || journal.blockers.length) return;
      try {
        input.profile.assertHeld();
        if (getProvider(current.provider.id).generation !== current.generation) return;
        current.provider.describe(current.connection.key);
      } catch {
        return;
      }
      try {
        current.sampler = makeSampler(id, current.lane, () => current, current.sampler);
      } catch {
        return;
      }
      current.quiescence = null;
      current.suspendOnly = false;
      delete current.resumeEvidence;
      current.snapshot.state = "connected";
      current.snapshot.revision++;
      changed();
    },
  };
  resumeObservers.set(sessions, (receipt) => {
    const current = session;
    if (!current || current.snapshot.sessionId !== receipt.sessionId) return "blocked";
    if (!current.quiescence && current.snapshot.state === "connected") return "resumed";
    if (
      !closing &&
      current.suspendOnly &&
      current.quiescence === receipt &&
      current.resumeEvidence?.recovery !== current.recoveryDisposition
    )
      return "pending";
    return "blocked";
  });
  const resourceDriver: ResourceDriver = {
    revokeOwner(owner, reason) {
      for (const [id, row] of lostUsb)
        if (
          row.principal.kind === "plugin" &&
          resourceOwnerKey(row.principal.owner) === resourceOwnerKey(owner)
        )
          forgetUsb(id);
      retired.add(resourceOwnerKey(owner));
      events.disposeOwner(owner);
      channels.delete(resourceOwnerKey(owner));
      intent.retire(owner);
      intentOwners.delete(resourceOwnerKey(owner));
      const ends = reservations.endOwner(
        owner,
        reason === "renderer-lost" ? "renderer-lost" : "retired",
        reason !== "crashed",
      );
      const promises = operations.stopOwner(owner);
      for (const operation of legacy.values())
        if (
          operation.principal.kind === "plugin" &&
          resourceOwnerKey(operation.principal.owner) === resourceOwnerKey(owner)
        ) {
          void operation.cancel();
          promises.push(operation.done);
        }
      return { drain: ends.find((e) => e.drain !== null)?.drain ?? null, settled: merge(promises) };
    },
    revokeProvider(id, generation) {
      for (const [ref, row] of lostUsb)
        if (row.providerId === id && row.generation === generation)
          forgetUsb(ref, "cancelled", "provider-retired");
      const current = session;
      if (!current || current.provider.id !== id || current.generation !== generation) return [];
      current.quiescence ??= finishSession(current, "disconnected");
      current.suspendOnly = false;
      return [settleRecovery(current, current.originalDisposition!, true)];
    },
    revokeAll() {
      closing = true;
      for (const id of lostUsb.keys()) forgetUsb(id, "cancelled", "shutdown");
      disposeRecoveryObservers();
      coreTelemetry.dispose();
      events.dispose();
      if (!session) return [];
      session.quiescence ??= finishSession(session, "suspended");
      session.suspendOnly = false;
      return [settleRecovery(session, session.originalDisposition!, true)];
    },
  };
  const resources = factories.participant(resourceDriver);
  const retainedRecoveryEvidence = new Map<number, Set<string>>();
  const recoveryDriver: RecoveryDriver = {
    wallNow: () => wallNow(),
    canClearResolved: (ids) =>
      ![...retainedRecoveryEvidence.values()].some((entries) => ids.some((id) => entries.has(id))),
    describe(sessionId) {
      const current = session;
      return current && current.snapshot.sessionId === sessionId
        ? {
            sessionId,
            providerGeneration: current.generation,
            physical: structuredClone(current.connection.physical),
          }
        : null;
    },
    async occupy(sessionId, work, binding) {
      const current = session;
      if (!current || current.snapshot.sessionId !== sessionId) return stale();
      if (current.recoveryClosed)
        return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "disconnected");
      if (reservations.active || coreReservations.active)
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "recording");
      const originalPhysical = structuredClone(current.connection.physical);
      const originalGeneration = current.generation,
        originalKey = current.connection.key;
      const validIdentity = () => {
        input.profile.assertHeld();
        const live = current.provider.describe(current.connection.key);
        return (
          session === current &&
          current.generation === originalGeneration &&
          current.connection.key === originalKey &&
          !current.connectionClosed &&
          live.key === current.connection.key &&
          samePhysical(live.physical, originalPhysical)
        );
      };
      if (
        binding &&
        (binding.session.sessionId !== sessionId ||
          binding.session.providerGeneration !== current.generation ||
          !samePhysical(binding.session.physical, originalPhysical) ||
          !isDeepStrictEqual(
            input.journal.snapshot().faults.find((e) => e.id === binding.fault.id),
            binding.fault,
          ) ||
          binding.fault.state === "resolved" ||
          !validIdentity())
      )
        return stale();
      if (
        current.lane.quarantined &&
        (!binding ||
          binding.fault.sessionId !== sessionId ||
          binding.fault.providerGeneration !== current.generation ||
          !samePhysical(binding.fault.physical, originalPhysical))
      )
        return stale();
      if (binding && current.providerPending.size)
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
      const id = randomUUID();
      if (binding) current.lane.reserveRecovery(id);
      else current.lane.reserve(id);
      if (binding) {
        // Pin before resolution publication: journal subscribers may immediately
        // request a clear, before the final proof has been installed.
        const retained = retainedRecoveryEvidence.get(current.generation) ?? new Set<string>();
        retained.add(binding.fault.id);
        retainedRecoveryEvidence.set(current.generation, retained);
      }
      // Session teardown must join recovery through final journal publication, not
      // merely wait for the last transport exchange to leave the lane.
      let settle!: (value: DeviceDisposition) => void;
      const disposition = new Promise<DeviceDisposition>((resolve) => {
        settle = resolve;
      });
      const sequence = current.recoveryHistory.length + 1;
      const receipt: Session["recoveryHistory"][number] = {
        sequence,
        owner: id,
        settled: disposition,
      };
      current.recoveryHistory.push(receipt);
      current.recoveryDisposition = disposition;
      let confirmed = false;
      let journalCommitted = false;
      let physicalProof = false;
      let resolution: SafetyFaultEntry | undefined;
      let recordedFault = false;
      const ctx = createContexts({
        id,
        sessionId,
        generation: originalGeneration,
        operationClass: "safety-stop",
        deadline: input.now() + 15000,
        now: input.now,
        lane: current.lane,
        check: () => {
          input.profile.assertHeld();
          if (
            session !== current ||
            current.generation !== originalGeneration ||
            current.connection.key !== originalKey ||
            !validIdentity()
          )
            return stale();
        },
        checkCleanup: () => {
          if (!validIdentity()) return stale();
        },
        progress: () => {},
        onStop: () => {},
      });
      try {
        const result = await work({
          observe: async () => {
            if (!validIdentity()) return stale();
            const outcome = await current.provider.observeIdle(originalKey, ctx.work);
            if (!validIdentity()) return stale();
            physicalProof = !outcome.error && isIdle(outcome.value);
            return outcome;
          },
          stop: async () => {
            if (!validIdentity()) return stale();
            const outcome = await current.provider.stopAndReadback(
              originalKey,
              { kind: "current-device" },
              ctx.cleanup,
            );
            if (!validIdentity()) return stale();
            physicalProof =
              !outcome.error && outcome.stopConfirmation === "confirmed" && isIdle(outcome.value);
            return outcome;
          },
          recorded: (entry) => {
            if (
              binding ||
              entry.sessionId !== sessionId ||
              entry.providerGeneration !== originalGeneration ||
              !samePhysical(entry.physical, originalPhysical) ||
              !isDeepStrictEqual(
                input.journal.snapshot().faults.find((e) => e.id === entry.id),
                entry,
              )
            )
              return stale();
            recordedFault = true;
          },
          resolved: (entry) => {
            if (
              !binding ||
              !physicalProof ||
              !validIdentity() ||
              entry.id !== binding.fault.id ||
              entry.revision !== binding.fault.revision + 1 ||
              entry.state !== "resolved" ||
              entry.stopConfirmation !== "confirmed" ||
              entry.resolution?.sessionId !== sessionId ||
              !isDeepStrictEqual(
                input.journal.snapshot().faults.find((e) => e.id === entry.id),
                entry,
              )
            )
              return stale();
            resolution = structuredClone(entry);
          },
        });
        confirmed =
          physicalProof &&
          !(typeof result === "object" && result !== null && "ok" in result && result.ok === false);
        journalCommitted = input.journal.snapshot().journalHealth === "ready";
        if (!confirmed) current.lane.quarantined = true;
        return result;
      } catch (error) {
        current.lane.quarantined = true;
        throw error;
      } finally {
        try {
          await current.lane.drain(ctx.cleanup.deadlineMonotonicMs);
        } finally {
          current.provider.releaseOperation(id);
          if (binding) current.lane.releaseRecovery(id);
          else current.lane.release(id);
          const snapshot = input.journal.snapshot();
          if (
            confirmed &&
            resolution &&
            !current.lane.occupied &&
            !current.providerPending.size &&
            snapshot.journalHealth === "ready"
          ) {
            const resolved = resolution;
            current.recoveryProofs.set(resolved.id, {
              sequence,
              covers: (owner) =>
                binding!.fault.operationId === owner ||
                current.recoveryHistory.some(
                  (row) =>
                    row.owner === owner &&
                    row.sequence < sequence &&
                    row.faultIds?.includes(resolved.id),
                ),
              valid: () => {
                try {
                  const journal = input.journal.snapshot();
                  return (
                    validIdentity() &&
                    journal.journalHealth === "ready" &&
                    isDeepStrictEqual(
                      journal.faults.find((e) => e.id === resolved.id),
                      resolved,
                    )
                  );
                } catch {
                  return false;
                }
              },
            });
          }
          const faultIds = binding
            ? confirmed && resolution
              ? []
              : [binding.fault.id]
            : recordedFault
              ? snapshot.blockers
              : [];
          receipt.faultIds = faultIds;
          settle({
            stopConfirmed: confirmed && !current.lane.occupied && !current.providerPending.size,
            journalCommitted: journalCommitted && snapshot.journalHealth === "ready",
            faultIds,
          });
        }
      }
    },
  };
  const recovery = factories.recovery({
    journal: input.journal,
    actions: input.coreActions,
    driver: recoveryDriver,
  });
  const sessionSnapshot = (current: Session): DeviceSessionSnapshot => {
    const foreground = current.lane.foreground;
    return {
      ...structuredClone(current.snapshot),
      state: current.lane.quarantined ? "quarantined" : current.snapshot.state,
      recording: reservations.active || coreReservations.active,
      foreground:
        foreground === null
          ? "none"
          : operations.rows.rows.has(foreground)
            ? "motion"
            : legacy.get(foreground)?.operationClass === "program-launch"
              ? "program"
              : legacy.has(foreground)
                ? "file"
                : "mode",
    };
  };
  const list = (principal: Principal) => {
    if (session?.snapshot.state === "connected" && !session.initialization)
      session.users.add(ownerKey(principal));
    return {
      revision,
      providers: providers.list().filter((row) => !providerHeld(row.providerId)),
      sessions: session && !session.initialization ? [sessionSnapshot(session)] : [],
    };
  };
  const ensureCapability = (
    current: Session,
    capability: DeviceSessionSnapshot["capabilities"][number],
  ) => {
    if (!current.snapshot.capabilities.includes(capability))
      return deviceFailure("PLUGIN_E_DEVICE_CAPABILITY", "unsupported-capability");
  };
  async function dispatch(
    principal: Principal,
    method: DeviceMethod,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const parse = <M extends DeviceMethod>(name: M) =>
      deviceRequestSchemas[name].params.parse(raw) as DeviceParams<M>;
    if (method === "devices/motion/query")
      return { operation: operations.query(principal, parse(method).operationId) };
    if (method === "devices/motion/stop") {
      const p = parse(method);
      return { operation: operations.stop(principal, p.operationId, p.stopMode) };
    }
    if (
      principal.kind === "core" &&
      ["devices/recording/query", "devices/recording/read", "devices/recording/release"].includes(
        method,
      )
    ) {
      const p = parse(method as "devices/recording/read");
      const snapshot = coreReservations.query(principal, p.reservationId);
      if (
        snapshot.state !== "ended" &&
        (!session || session.snapshot.sessionId !== snapshot.sessionId)
      )
        return stale("reservation");
      // A healthy ended reservation retains its bounded drain, but a retired window never does.
      const ref = principal.authorityContext?.ref;
      const context = ref ? input.authority.current(principal, ref) : null;
      assertPrincipal(principal);
      if (
        principal.hostEpoch !== input.profile.hostEpoch ||
        !context ||
        context.state === "invalid" ||
        context.epoch !== principal.authorityContext?.epoch ||
        context.workbenchInstance !== principal.workbenchInstance
      )
        return stale("reservation");
      permission(principal, "devices.read");
      if (method === "devices/recording/read")
        return coreReservations.read(principal, p.reservationId, p.afterSequence, p.limit);
      if (method === "devices/recording/release")
        coreReservations.end(p.reservationId, "released", true);
      return { reservation: coreReservations.query(principal, p.reservationId) };
    }
    if (method === "devices/recording/query") {
      if (principal.kind !== "plugin") return stale("reservation");
      return { reservation: reservations.query(principal.owner, parse(method).reservationId) };
    }
    if (method === "devices/recording/read") {
      if (principal.kind !== "plugin") return stale("reservation");
      const p = parse(method);
      return reservations.read(principal.owner, p.reservationId, p.afterSequence, p.limit);
    }
    if (method === "devices/recording/release") {
      if (principal.kind !== "plugin") return stale("reservation");
      const p = parse(method);
      reservations.query(principal.owner, p.reservationId);
      reservations.end(p.reservationId, "released", true);
      return { reservation: reservations.query(principal.owner, p.reservationId) };
    }
    if (method === "events/unsubscribe" || method === "events/ack") {
      if (principal.kind !== "plugin") return stale("subscription");
      if (method === "events/unsubscribe") {
        const result = events.unsubscribe(principal.owner, parse(method).subscriptionId);
        if (!result.ok) throw new BrokerFailure(result);
        return result.value;
      }
      const params = parse(method),
        result = events.ack(principal.owner, params.subscriptionId, params.sequence);
      if (!result.ok) throw new BrokerFailure(result);
      return result.value;
    }
    assertPrincipal(principal);
    if (signal.aborted)
      throw new RpcError(RPC_ERRORS.requestCancelled, "Cancelled before admission.");
    if (method === "devices/negotiate") {
      const requirements = principal.kind === "plugin" ? input.requirements(principal.owner) : [];
      if (requirements === null) return stale();
      const known = [
        "connection.v1",
        "telemetry.v1",
        "inputModes.v1",
        "finiteMotion.v1",
        "recordingReservation.v1",
      ];
      const capabilities = [
        ...new Set([...known, ...requirements.map((row) => row.capability)]),
      ].map((capability) => {
        const registration = providers
          .list()
          .find(
            (row) =>
              !providerHeld(row.providerId) &&
              row.state === "available" &&
              row.capabilities.includes(capability as (typeof row.capabilities)[number]),
          );
        return {
          capability,
          state: !known.includes(capability)
            ? ("unsupported" as const)
            : !registration
              ? ("provider-unavailable" as const)
              : capability !== "connection.v1" && !session
                ? ("no-session" as const)
                : ("available" as const),
          providerId: registration?.providerId ?? null,
        };
      });
      return {
        devicesContractVersion: 1,
        eventVersion: 1,
        capabilities,
        requirementsSatisfied: requirements.every(
          (row) =>
            !row.required ||
            capabilities.some(
              (value) => value.capability === row.capability && value.state === "available",
            ),
        ),
      };
    }
    if (method === "devices/context") {
      const p = parse(method),
        ref = p.contextRef ?? principal.authorityContext?.ref;
      const context = ref ? input.authority.current(principal, ref) : null;
      return {
        contextRef: context?.ref ?? null,
        revision: 0,
        state:
          context?.state === "local"
            ? "local"
            : context?.isHolder
              ? "allowed"
              : context
                ? "restricted"
                : "unbound",
        reason:
          context?.state === "local"
            ? "local"
            : !context
              ? "unbound"
              : context.state === "joining"
                ? "joining"
                : !context.synced
                  ? "unsynced"
                  : context.role === "viewer"
                    ? "viewer"
                    : context.isHolder
                      ? "holder"
                      : "not-holder",
      };
    }
    permission(
      principal,
      method === "devices/connect" ||
        method === "devices/disconnect" ||
        method === "devices/discover"
        ? "devices.connect"
        : method === "devices/motion/prepare" ||
            method === "devices/motion/start" ||
            method === "devices/inputModes/set"
          ? "devices.control"
          : "devices.read",
    );
    if (method === "devices/connectionRecovery/read") return recoverySnapshot();
    if (method === "devices/list") return list(principal);
    if (method === "devices/discover") {
      const p = parse(method),
        registration = getProvider(p.providerId),
        ctx = contexts(principal, null, "connection", 10000, randomUUID(), () => {
          if (getProvider(p.providerId).generation !== registration.generation) return stale();
        });
      if (!registration.provider.capabilities.includes("connection.v1"))
        return deviceFailure("PLUGIN_E_DEVICE_CAPABILITY", "unsupported-capability");
      const found = value(
        await trackProviderWork(registration.generation, registration.provider.discover(ctx.work)),
      );
      ctx.work.assertContinuation("discover");
      if (found.length > 32) return quota("candidate", 32);
      const result: DeviceCandidate[] = [];
      for (const candidate of found) {
        providers.claim(p.providerId, candidate.physical);
        getProvider(p.providerId);
        const id = candidates.add(ownerKey(principal), {
          candidate,
          generation: registration.generation,
          expires: input.now() + 30000,
        });
        result.push({ ...candidate.descriptor, candidateId: id, expiresInMs: 30000 });
      }
      return { candidates: result };
    }
    if (method === "devices/connect") {
      if (
        connecting ||
        projection?.phase === "cancelling" ||
        projection?.phase === "cancel-failed" ||
        (retainedConnection !== null && !retainedConnection.closed) ||
        connectionLane.occupied ||
        session?.snapshot.state === "connected" ||
        (session &&
          !session.connectionClosed &&
          (session.lane.quarantined || session.snapshot.state === "quarantined"))
      )
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "connecting");
      // A pre-session timeout blocks admission only until its I/O actually settles.
      connectionLane.quarantined = false;
      connecting = true;
      let removeAbort = () => {};
      let custody: ConnectionCustody | undefined;
      try {
        const p = parse(method);
        let providerId: string,
          target: ProviderCandidate["key"] | { wifiAddress: string },
          generation: number,
          recoveryCapture: ((custody: ConnectionCustody) => void) | undefined,
          recoveryCheck: (() => void) | undefined,
          recoveryAdopt: ((snapshot: DeviceSessionSnapshot) => void) | undefined;
        if (p.target.kind === "candidate") {
          const row = candidates.get(ownerKey(principal), p.target.candidateId);
          if (input.now() >= row.expires) return stale("candidate");
          providerId = row.candidate.descriptor.providerId;
          target = row.candidate.key;
          generation = row.generation;
          recoveryCapture = row.recoveryCapture;
          recoveryCheck = row.recoveryCheck;
          recoveryAdopt = row.recoveryAdopt;
          recoveryCheck?.();
          candidates.remove(p.target.candidateId);
        } else {
          providerId = p.target.providerId;
          target = { wifiAddress: p.target.address };
          generation = getProvider(providerId).generation;
        }
        const registration = getProvider(providerId);
        if (generation !== registration.generation) return stale("candidate");
        if (!registration.provider.capabilities.includes("connection.v1"))
          return deviceFailure("PLUGIN_E_DEVICE_CAPABILITY", "unsupported-capability");
        const policy = Object.freeze({ ...input.connectionPolicy() });
        attemptPolicies.set(providerId, policy);
        gate(principal, "connection", null, "admission");
        if (!recoveryCheck)
          for (const id of lostUsb.keys()) forgetUsb(id, "cancelled", "superseded");
        const ctx = contexts(
          principal,
          null,
          "connection",
          policy.wifiConnectTimeoutMs + policy.wifiHandshakeTimeoutMs,
          randomUUID(),
          () => {
            recoveryCheck?.();
            if (getProvider(providerId).generation !== generation) return stale();
          },
          undefined,
          generation,
        );
        const onAbort = () => ctx.stop("cancelled", true);
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
        const connection = value(
          await trackProviderWork(generation, registration.provider.connect(target, ctx.work)),
        );
        // Capture the exact returned handle before any current-owner or cancellation
        // check can throw. Cleanup uses this attempt's context, never a new grant.
        let acquired: Session | undefined = undefined;
        let cleanup: Promise<boolean> | undefined;
        let disconnecting: Promise<ProviderOutcome<null>> | undefined;
        const held: ConnectionCustody = {
          generation,
          closed: false,
          attempted: false,
          close() {
            if (held.closed) return Promise.resolve(true);
            if (cleanup) return cleanup;
            held.attempted = true;
            // Closing the handle cannot settle an earlier uncertain transport exchange.
            const priorQuarantine = acquired?.lane.quarantined ?? false;
            cleanup = (async () => {
              let confirmed = false;
              try {
                ctx.stop("cancelled", true);
                ctx.cleanup.assertCleanup("disconnect");
                const deadline = ctx.cleanup.deadlineMonotonicMs;
                if (acquired) {
                  acquired.sampler.dispose();
                  await bounded(
                    Promise.all([...acquired.providerPending]),
                    Math.max(0, deadline - input.now()),
                  );
                  await acquired.lane.drain(deadline);
                }
                if (!disconnecting) {
                  disconnecting = trackProviderWork(
                    generation,
                    registration.provider.disconnect(connection.key, ctx.cleanup),
                  );
                  // A late confirmed receipt settles this exact retained handle even
                  // after the caller timed out. It never touches a replacement session.
                  void disconnecting.then(
                    (result) => {
                      if (
                        result.error ||
                        (result.stopConfirmation !== "confirmed" &&
                          result.stopConfirmation !== "not-required")
                      )
                        return;
                      held.closed = true;
                      if (acquired) {
                        acquired.connectionClosed = true;
                        acquired.lane.quarantined = priorQuarantine;
                        acquired.snapshot.state = "disconnected";
                      }
                      if (retainedConnection === held) retainedConnection = null;
                    },
                    () => {},
                  );
                }
                const result = await bounded(disconnecting, Math.max(0, deadline - input.now()));
                disconnecting = undefined;
                confirmed =
                  !result.error &&
                  (result.stopConfirmation === "confirmed" ||
                    result.stopConfirmation === "not-required");
              } catch {
                /* Retain the original handle and lane on uncertain cleanup. */
              }
              held.closed = confirmed;
              if (acquired) {
                acquired.connectionClosed = confirmed;
                acquired.lane.quarantined = priorQuarantine || !confirmed;
                acquired.snapshot.state = confirmed ? "disconnected" : "quarantined";
              }
              if (confirmed && retainedConnection === held) retainedConnection = null;
              else if (!confirmed) connectionLane.quarantined = true;
              return confirmed;
            })().finally(() => {
              cleanup = undefined;
            });
            return cleanup;
          },
        };
        custody = held;
        retainedConnection = custody;
        recoveryCapture?.(custody);
        ctx.work.assertContinuation("connect");
        providers.claim(providerId, connection.physical);
        getProvider(providerId);
        const id = randomUUID(),
          lane = new ExchangeLane(input.now);
        const snapshot: DeviceSessionSnapshot = {
          sessionId: id,
          providerId,
          providerGeneration: generation,
          revision: 1,
          name: connection.descriptor.name,
          transport: connection.descriptor.transport,
          capabilities: connection.capabilities,
          state: "connected",
          foreground: "none",
          recording: false,
          sourceRevision: 1,
        };
        const sampler = makeSampler(id, lane, () => current);
        session?.unregister();
        const providerPending = new Set<Promise<unknown>>();
        const current: Session = {
          hadReservations: false,
          providerPending,
          recoveryHistory: [],
          recoveryProofs: new Map(),
          snapshot,
          sources: { sessionId: id, sourceRevision: 1, channels: [], actuators: [] },
          connection,
          provider: trackedProvider(registration.provider, providerPending),
          generation,
          lane,
          sampler,
          quiescence: null,
          suspendOnly: false,
          users: new Set([ownerKey(principal), ownerKey(samplerPrincipal)]),
          unregister: () => {},
        };
        session = current;
        acquired = current;
        const initialize = async () => {
          try {
            const outcome = await current.provider.sources(
              connection.key,
              contexts(principal, current, "passive-read", 10000, randomUUID(), () =>
                ctx.work.assertContinuation("connect"),
              ).work,
            );
            // Preserve the provider's failure before an admission withdrawal can
            // replace it with a cancellation. Native close is not transport proof.
            if (
              outcome.error &&
              (outcome.dispatch === "unknown" ||
                outcome.stopConfirmation === "unconfirmed" ||
                outcome.error.reason === "provider-failure" ||
                outcome.error.reason === "provider-contract")
            )
              current.lane.quarantined = true;
            ctx.work.assertContinuation("connect");
            if (
              outcome.error?.reason === "provider-disabled" &&
              outcome.dispatch !== "unknown" &&
              outcome.stopConfirmation !== "unconfirmed"
            )
              deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "provider-disabled");
            current.sources = sourceCatalogSchema.parse(value(outcome));
            getSession(principal, id);
            snapshot.sourceRevision = current.sources.sourceRevision;
          } catch (error) {
            current.sampler.dispose();
            throw error;
          }
        };
        current.initialization = initialize();
        try {
          await current.initialization;
        } finally {
          delete current.initialization;
        }
        current.unregister = current.provider.onDisconnect((key) => {
          if (key !== connection.key) return;
          current.suspendOnly = false;
          if (current.snapshot.state === "disconnected") return;
          if (current.quiescence)
            notifyLifecycle({
              kind: "lost",
              session: { ...current.snapshot, state: "disconnected" },
              message: "The EV3 connection was lost.",
            });
          else current.quiescence = finishSession(current, "disconnected", true);
          // Commit physical loss even when the subsequent authoritative policy
          // read fails (including a previously quiesced session).
          current.snapshot.state = "disconnected";
          revision++;
          changed(false, "lost");
          // The retained automatic-recovery contract is USB-only. Wi-Fi loss
          // already published the ordinary disconnected state above.
          if (current.snapshot.transport !== "usb") return;
          let lossPolicy: ReturnType<Options["connectionPolicy"]> | null = null;
          try {
            lossPolicy = Object.freeze({ ...input.connectionPolicy() });
          } catch {
            // The connect-admission policy is retained only to describe the
            // cancelled episode below. It never admits retry work.
          }
          const row: Episode = {
            principal,
            providerId,
            generation,
            digest: current.connection.physical.digest ?? "",
            settled: current.quiescence.settled,
            policy: lossPolicy ?? policy,
            attempts: 0,
            timer: null,
            pending: false,
            control: new AbortController(),
            ref: {
              recoveryId: randomUUID(),
              providerId,
              providerGeneration: generation,
              previousSessionId: id,
            },
            name: current.snapshot.name,
            due: input.now(),
            done: Promise.resolve(),
          };
          latestEpisode = row;
          if (!lossPolicy) {
            void cancelEpisode(row, "policy");
            recoveryState(id, "unavailable");
            return;
          }
          if (
            current.snapshot.transport === "usb" &&
            current.connection.physical.basis === "serial" &&
            current.connection.physical.digest !== null &&
            lossPolicy.usbAutoReconnect
          ) {
            lostUsb.set(id, row);
            scheduleUsb(id);
          } else {
            publishRecovery(row, {
              phase: "manual-required",
              reason: !lossPolicy.usbAutoReconnect ? "auto-disabled" : "identity-unavailable",
            });
            recoveryState(id, "unavailable");
          }
        });
        // Recovery adoption and its retained terminal publication share this
        // synchronous turn. A later cancel cannot claim a connecting episode
        // after the new usable session has already escaped to subscribers.
        recoveryAdopt?.(snapshot);
        retainedConnection = null;
        custody = undefined;
        if (!recoveryAdopt && latestEpisode) clearRecovery();
        sessionOrigin = principal.kind;
        revision++;
        changed(false, recoveryAdopt ? "recovered" : "connected");
        return { session: structuredClone(snapshot) };
      } catch (error) {
        if (custody && !custody.closed) await custody.close();
        throw error;
      } finally {
        removeAbort();
        connecting = false;
        attemptPolicies.clear();
      }
    }
    if (method === "devices/motion/start") {
      const p = parse(method);
      return { operation: operations.start(principal, p.operationId) };
    }
    if (method === "devices/motion/prepare") {
      const p = parse(method),
        current = getSession(principal, p.sessionId);
      ensureCapability(current, "finiteMotion.v1");
      gate(principal, "finite-motion", p.sessionId, "admission");
      if (
        !current.sources.actuators.some(
          (a) => a.actuatorId === p.motion.actuatorId && a.state === "ready",
        )
      )
        return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "motor-unavailable");
      return {
        operation: operations.prepare({
          principal,
          sessionId: p.sessionId,
          generation: current.generation,
          physical: current.connection.physical,
          provider: current.provider,
          key: current.connection.key,
          lane: current.lane,
          motion: p.motion,
          contextRef: p.contextRef,
          motionScopeRef: p.motionScopeRef,
          ...(p.gestureRef ? { gestureRef: p.gestureRef } : {}),
        }),
      };
    }
    if (method === "devices/subscribe") {
      if (principal.kind !== "plugin") return stale("subscription");
      const channel = channels.get(resourceOwnerKey(principal.owner));
      if (!channel?.domains.has("devices"))
        return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "provider-disabled");
      const params = parse(method),
        owner = principal.owner;
      const read = (): DeviceSubscriptionSnapshot => {
        switch (params.topic) {
          case "connectionRecovery":
            return recoverySnapshot();
          case "catalog":
            return list(principal);
          case "session": {
            const row = getSession(principal, params.sessionId);
            return { session: sessionSnapshot(row), sources: structuredClone(row.sources) };
          }
          case "telemetry": {
            const row = getSession(principal, params.sessionId);
            if (
              params.channelIds.some((id) => !row.sources.channels.some((c) => c.channelId === id))
            )
              return stale();
            return row.sampler.snapshot();
          }
          case "motion":
            return operations.query(principal, params.operationId);
          case "reservation":
            return reservations.query(owner, params.reservationId);
          case "authority": {
            const context = input.authority.current(principal, params.contextRef);
            return {
              contextRef: context?.ref ?? null,
              revision: 0,
              state:
                context?.state === "local"
                  ? "local"
                  : context?.isHolder
                    ? "allowed"
                    : context
                      ? "restricted"
                      : "unbound",
              reason:
                context?.state === "local"
                  ? "local"
                  : !context
                    ? "unbound"
                    : context.state === "joining"
                      ? "joining"
                      : !context.synced
                        ? "unsynced"
                        : context.role === "viewer"
                          ? "viewer"
                          : context.isHolder
                            ? "holder"
                            : "not-holder",
            };
          }
        }
      };
      const snapshot = read(),
        created = events.create(owner);
      if (!created.ok) throw new BrokerFailure(created);
      const id = created.value.subscriptionId;
      let dispose = () => {};
      if (params.topic === "telemetry") {
        const current = getSession(principal, params.sessionId),
          undemand = current.sampler.demand(id, params.intervalMs);
        const unlisten = current.sampler.subscribe((frame) => {
          if (!events.owns(owner, id)) return;
          try {
            events.publish(
              owner,
              id,
              {
                kind: "devices.telemetry",
                data: {
                  sessionId: params.sessionId,
                  frames: [
                    {
                      ...frame,
                      values: frame.values.filter((value) =>
                        params.channelIds.includes(value.channelId),
                      ),
                    },
                  ],
                  snapshot: current.sampler.snapshot(),
                },
              },
              "telemetry",
            );
          } catch {
            /* Terminal rows and transport failures are local to this consumer. */
          }
        });
        dispose = () => {
          unlisten();
          undemand();
        };
      }
      const publish = (event: Stage3Event, terminal = false) => {
        if (!events.owns(owner, id)) return;
        try {
          events.publish(owner, id, event, "control");
          if (terminal) events.closeAfterControl(owner, id);
        } catch {
          /* The ledger handles transport failure and terminal ACK retention. */
        }
      };
      let notify = (_sourcesChanged = false) => {};
      if (params.topic === "connectionRecovery")
        notify = () => publish({ kind: "devices.connectionRecovery", data: recoverySnapshot() });
      if (params.topic === "catalog")
        notify = () => publish({ kind: "devices.catalog", data: list(principal) });
      if (params.topic === "session") {
        const row = getSession(principal, params.sessionId);
        notify = (sourcesChanged = false) =>
          publish(
            { kind: "devices.session", data: { session: sessionSnapshot(row), sourcesChanged } },
            row.snapshot.state === "disconnected",
          );
      }
      if (params.topic === "motion")
        dispose = operations.subscribe((snapshot) => {
          if (snapshot.operationId === params.operationId)
            publish({ kind: "devices.motion", data: snapshot }, snapshot.stage === "terminal");
        });
      if (params.topic === "reservation")
        dispose = reservations.subscribe((snapshot) => {
          if (snapshot.reservationId === params.reservationId)
            publish({ kind: "devices.reservation", data: snapshot }, snapshot.state === "ended");
        });
      if (params.topic === "authority")
        dispose = input.authority.subscribe((ref) => {
          if (ref === params.contextRef)
            publish({
              kind: "devices.authority",
              data: read() as AuthoritySnapshot,
            });
        });
      subscriptions.set(id, { owner, params, notify, dispose });
      return { subscriptionId: id, sequence: 0, snapshot };
    }
    const params = raw as { sessionId: string };
    const current = getSession(principal, params.sessionId);
    if (method === "devices/disconnect") {
      forgetUsb(current.snapshot.sessionId);
      if (current.lane.foreground !== null || reservations.active || coreReservations.active)
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
      const ctx = contexts(principal, current, "connection", 60000);
      const result = await current.provider.disconnect(current.connection.key, ctx.cleanup);
      if (result.error)
        return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-failure", result.dispatch);
      current.sampler.dispose();
      current.unregister();
      current.snapshot.state = "disconnected";
      const snapshot = structuredClone(current.snapshot);
      session = null;
      revision++;
      changed();
      return { session: snapshot };
    }
    if (method === "devices/session")
      return { session: sessionSnapshot(current), sources: structuredClone(current.sources) };
    if (method === "devices/read") {
      ensureCapability(current, "telemetry.v1");
      const p = parse(method);
      if (p.channelIds.some((id) => !current.sources.channels.some((c) => c.channelId === id)))
        return stale();
      const snapshot =
        p.freshness === "fresh" ? await current.sampler.fresh() : current.sampler.snapshot();
      getSession(principal, p.sessionId);
      permission(principal, "devices.read");
      if (p.channelIds.some((id) => !current.sources.channels.some((c) => c.channelId === id)))
        return stale();
      return {
        ...snapshot,
        frame: snapshot.frame
          ? {
              ...snapshot.frame,
              values: snapshot.frame.values.filter((v) => p.channelIds.includes(v.channelId)),
            }
          : null,
      };
    }
    if (method === "devices/recording/reserve") {
      ensureCapability(current, "recordingReservation.v1");
      const p = parse(method);
      const check = () => {
        getSession(principal, p.sessionId);
        if (principal.kind === "core") checkCore(principal, current);
        ensureCapability(current, "recordingReservation.v1");
        permission(principal, "devices.read");
        gate(principal, "recording-reservation", p.sessionId, "admission");
        if (!principal.authorityContext)
          return deviceFailure("PLUGIN_E_DEVICE_AUTHORITY", "unbound");
        input.authority.assertContinuation(principal, principal.authorityContext.ref);
        if (current.lane.foreground !== null)
          return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
        if (current.sources.sourceRevision !== p.expectedSourceRevision)
          return stale("reservation");
      };
      const channels = p.channelIds.map(
        (id) => current.sources.channels.find((c) => c.channelId === id) ?? stale("reservation"),
      );
      if (reservations.active || coreReservations.active)
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "recording");
      if (reservations.size + coreReservations.size >= 256) quota("reservation", 256);
      const args = {
        sessionId: p.sessionId,
        providerGeneration: current.generation,
        channels,
        sourceRevision: p.expectedSourceRevision,
        check,
        fresh: () => current.sampler.fresh(),
      };
      const result =
        principal.kind === "plugin"
          ? await reservations.reserve({ ...args, owner: principal.owner })
          : await coreReservations.reserve({
              ...args,
              owner: {
                kind: "core",
                adapter: principal.adapter,
                hostEpoch: principal.hostEpoch,
                workbenchInstance: principal.workbenchInstance,
              },
            });
      const store = principal.kind === "plugin" ? reservations : coreReservations;
      current.hadReservations = true;
      const undemand = current.sampler.demand(result.reservation.reservationId, 500);
      const unlisten = store.onEnded((event) => {
        if (event.reservationId === result.reservation.reservationId) {
          undemand();
          unlisten();
          clearInterval(coreWatch);
          current.snapshot.recording = false;
        }
      });
      const coreWatch =
        principal.kind === "core"
          ? setInterval(() => {
              if (!validCore(principal, current))
                coreReservations.end(result.reservation.reservationId, "renderer-lost", false);
            }, 500)
          : undefined;
      coreWatch?.unref();
      current.snapshot.recording = true;
      return result;
    }
    if (method === "devices/inputModes/query" || method === "devices/inputModes/set") {
      ensureCapability(current, "inputModes.v1");
      gate(
        principal,
        method.endsWith("/set") ? "mode-write" : "mode-read",
        current.snapshot.sessionId,
        "admission",
      );
      const p = parse(method);
      if (p.expectedSourceRevision !== current.sources.sourceRevision) return stale();
      if (method === "devices/inputModes/set" && (reservations.active || coreReservations.active))
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "recording");
      const id = randomUUID();
      current.lane.reserve(id);
      const ctx = contexts(
        principal,
        current,
        method.endsWith("/set") ? "mode-write" : "mode-read",
        60000,
        id,
      );
      try {
        if (method === "devices/inputModes/query")
          return value(await current.provider.inputModes(current.connection.key, p, ctx.work));
        const modeChange = parse("devices/inputModes/set");
        input.authority.assertContinuation(principal, modeChange.contextRef);
        const result = value(
          await current.provider.setInputMode(current.connection.key, modeChange, ctx.work),
        );
        ctx.work.assertContinuation("read");
        publishSources(current, result.sources);
        return {
          ...result,
          snapshot: result.snapshot.frame
            ? current.sampler.receive(result.snapshot.frame)
            : result.snapshot,
        };
      } catch (error) {
        // A failed write may have changed the physical source. Preserve the last
        // confirmed revision and prompt consumers to refresh, as before.
        if (method === "devices/inputModes/set") changed(true);
        throw error;
      } finally {
        current.lane.release(id);
      }
    }
    throw new RpcError(RPC_ERRORS.methodNotFound, "Unknown device method.");
  }
  const writeProgram = async (entry: SafetyFaultEntry) => {
    input.profile.assertHeld();
    const document = await input.journal.load();
    input.profile.assertHeld();
    const entries = document.entries.filter((e) => e.id !== entry.id);
    while (entries.length >= 64) {
      const index = entries.findIndex((e) => e.state === "resolved");
      if (index < 0) quota("journal", 64);
      entries.splice(index, 1);
    }
    entries.push(entry);
    await bounded(input.journal.commit(journalDocument(document.revision + 1, entries)), 5000);
  };
  const catalogBindings = new Map<string, CatalogBinding>();
  const providerCatalog: DeviceBrokerPort["providerCatalog"] = (providerId) => {
    if (providerId !== "kobrixa.device-ev3")
      return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "provider-disabled");
    if (catalogBindings.has(providerId))
      return deviceFailure("PLUGIN_E_PROVIDER_CONFLICT", "provider-conflict");
    const binding: CatalogBinding = {
      generation: null,
      retired: false,
      ids: new Map(),
      observation: null,
    };
    catalogBindings.set(providerId, binding);
    const currentSession = (id: string) => {
      const current = session;
      if (
        binding.retired ||
        binding.generation === null ||
        !current ||
        current.provider.id !== providerId ||
        current.generation !== binding.generation ||
        id !== current.snapshot.sessionId
      )
        return stale();
      getProvider(providerId);
      return current;
    };
    const tupleKey = (tuple: SourceTuple) => {
      const fields = channelDefinitionSchema.shape;
      for (const field of ["portId", "typeId", "modeId", "component", "unit"] as const)
        if (!fields[field].safeParse(tuple[field]).success)
          return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-contract");
      validateDeviceWire("provider.channel", tuple);
      return JSON.stringify([
        tuple.sessionId,
        tuple.portId,
        tuple.typeId,
        tuple.modeId,
        tuple.component,
        tuple.unit,
      ]);
    };
    const port: ProviderCatalogPort = {
      connectionPolicy: () =>
        attemptPolicies.get(providerId) ?? Object.freeze({ ...input.connectionPolicy() }),
      identify(tuple) {
        const current = currentSession(tuple.sessionId);
        const identity = tupleKey(tuple);
        if (binding.observation?.sessionId === tuple.sessionId) {
          // Only the immediately observed generation is eligible. Returning to
          // an earlier tuple cannot reach a historical ID, even before publish.
          return binding.observation.ids.get(identity) ?? stale();
        }
        const key = JSON.stringify([
          binding.generation,
          tuple.sessionId,
          current.snapshot.sourceRevision,
          tuple.portId,
          tuple.typeId,
          tuple.modeId,
          tuple.component,
          tuple.unit,
        ]);
        let id = binding.ids.get(key);
        if (!id) {
          id = randomUUID();
          binding.ids.set(key, id);
        }
        return id;
      },
    };
    catalogObservers.set(port, (sessionId, tuples) => {
      currentSession(sessionId);
      // The complete observation includes channels and actuators (38 + 4).
      if (tuples.length > 42 || tuples.some((tuple) => tuple.sessionId !== sessionId))
        return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-contract");
      const keys = tuples.map(tupleKey).sort();
      const signature = JSON.stringify(keys);
      const previous = binding.observation?.sessionId === sessionId ? binding.observation : null;
      if (previous?.signature === signature) return;
      const ids = new Map(keys.map((key) => [key, previous?.ids.get(key) ?? randomUUID()]));
      binding.observation = {
        sessionId,
        generation: (previous?.generation ?? 0) + 1,
        signature,
        ids,
      };
      // No historical allocation can reappear after a disappearance/replacement.
      binding.ids.clear();
    });
    return port;
  };
  const broker: DeviceBrokerPort & LegacyOperationPort = {
    intent: {
      bindMotionScope(binding) {
        intentOwners.set(resourceOwnerKey(binding.owner), structuredClone(binding.owner));
        return intent.bindMotionScope(binding);
      },
      pulsePanel: (scope, sequence) => intent.pulsePanel(scope, sequence),
      revokeScope: (scope, reason) => intent.revokeScope(scope, reason),
      beginGesture: (scope, sequence) => intent.beginGesture(scope, sequence),
      pulseGesture: (gesture, sequence) => intent.pulseGesture(gesture, sequence),
      endGesture: (gesture, reason) => intent.endGesture(gesture, reason),
    },
    reservations,
    sessions,
    resources,
    recovery,
    connectionRecovery: {
      snapshot: recoverySnapshot,
      async cancel({ target, action }) {
        const row = latestEpisode;
        try {
          if (
            !row ||
            !isDeepStrictEqual(row.ref, target) ||
            !projection ||
            !["waiting", "connecting", "cancelling", "cancel-failed"].includes(projection.phase)
          )
            return stale("rpc");
          if (
            !input.coreActions.claim(action, {
              kind: "device-connection-recovery-cancel",
              ...row.ref,
            })
          )
            return actionFailure();
          try {
            await cancelEpisode(row, "user");
            return { ok: true, value: recoverySnapshot() };
          } finally {
            input.coreActions.complete(action);
          }
        } catch (error) {
          if (error instanceof BrokerFailure) return error.result;
          throw error;
        }
      },
    },
    events,
    providerCatalog,
    async reconnectForRecovery({ previousSessionId, signal }) {
      let attemptedConnection = false;
      let admitted: Episode | undefined;
      let settled = () => {};
      let removeDiscoveryAbort = () => {};
      try {
        const previous = lostUsb.get(previousSessionId);
        if (!previous || previous.pending || signal.aborted || !usbLive(previous)) return stale();
        signal = AbortSignal.any([signal, previous.control.signal]);
        const policy = readRecoveryPolicy(previous);
        if (!policy) return stale();
        previous.policy = policy;
        if (
          previous.attempts >= Number.MAX_SAFE_INTEGER ||
          (previous.policy.usbRetryLimit !== "unlimited" &&
            previous.attempts >= previous.policy.usbRetryLimit)
        ) {
          forgetUsb(previousSessionId, "exhausted");
          return stale();
        }
        admitted = previous;
        previous.pending = true;
        previous.done = new Promise<void>((resolve) => {
          settled = resolve;
        });
        previous.attempts++;
        publishRecovery(previous, { phase: "connecting" });
        if (previous.timer) {
          clearTimeout(previous.timer);
          previous.timer = null;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            try {
              deviceFailure("PLUGIN_E_CANCELLED", "cancelled");
            } catch (error) {
              reject(error);
            }
          };
          signal.addEventListener("abort", abort, { once: true });
          void previous.settled.then(
            () => {
              signal.removeEventListener("abort", abort);
              resolve();
            },
            (error: unknown) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          );
          if (signal.aborted) abort();
        });
        if (lostUsb.get(previousSessionId) !== previous || !usbLive(previous)) return stale();
        assertPrincipal(previous.principal);
        gate(previous.principal, "connection", null, "admission");
        const registration = getProvider(previous.providerId);
        if (registration.generation !== previous.generation) return stale();
        const recoveryCheck = () => {
          if (signal.aborted) return deviceFailure("PLUGIN_E_CANCELLED", "cancelled");
          if (lostUsb.get(previousSessionId) !== previous || !usbLive(previous)) return stale();
        };
        const ctx = contexts(
          previous.principal,
          null,
          "connection",
          10000,
          randomUUID(),
          recoveryCheck,
        );
        const abortDiscovery = () => ctx.stop("cancelled", true);
        signal.addEventListener("abort", abortDiscovery, { once: true });
        removeDiscoveryAbort = () => signal.removeEventListener("abort", abortDiscovery);
        if (signal.aborted) abortDiscovery();
        const found = value(
          await trackProviderWork(
            registration.generation,
            registration.provider.discover(ctx.work),
          ),
        );
        ctx.work.assertContinuation("discover");
        if (signal.aborted || lostUsb.get(previousSessionId) !== previous) return stale();
        const journal = await input.journal.load();
        recoveryCheck();
        if (
          journal.entries.some(
            (entry) =>
              entry.sessionId === previousSessionId &&
              (entry.physical.basis !== "serial" || entry.physical.digest !== previous.digest),
          )
        ) {
          forgetUsb(previousSessionId, null);
          publishRecovery(previous, { phase: "manual-required", reason: "identity-ambiguous" });
          recoveryState(previousSessionId, "unavailable");
          return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "identity-ambiguous");
        }
        const matches = found.filter(
          (candidate) =>
            candidate.descriptor.transport === "usb" &&
            candidate.physical.basis === "serial" &&
            candidate.physical.digest === previous.digest,
        );
        if (matches.length === 0)
          return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "disconnected");
        if (matches.length > 1) {
          forgetUsb(previousSessionId, null);
          publishRecovery(previous, { phase: "manual-required", reason: "identity-ambiguous" });
          recoveryState(previousSessionId, "unavailable");
          return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "identity-ambiguous");
        }
        attemptedConnection = true;
        recoveryState(previousSessionId, "connecting");
        let adopted = false;
        const candidateId = candidates.add(ownerKey(previous.principal), {
          candidate: matches[0]!,
          generation: previous.generation,
          expires: input.now() + 30000,
          recoveryCheck,
          recoveryCapture: (custody) => {
            previous.custody = custody;
          },
          recoveryAdopt: (snapshot) => {
            recoveryCheck();
            adopted = true;
            forgetUsb(previousSessionId, null);
            publishRecovery(previous, { phase: "restored", sessionId: snapshot.sessionId });
            recoveryState(previousSessionId, "restored", snapshot);
          },
        });
        const connected = await broker.request(
          previous.principal,
          "devices/connect",
          { target: { kind: "candidate", candidateId } },
          signal,
        );
        if (!connected.ok) return connected;
        if (!adopted) return stale();
        return { ok: true, value: { sessionId: connected.value.session.sessionId } };
      } catch (error) {
        if (error instanceof BrokerFailure) return error.result;
        throw error;
      } finally {
        removeDiscoveryAbort();
        if (admitted) admitted.pending = false;
        settled();
        const previous = lostUsb.get(previousSessionId);
        if (previous) {
          if (previous.custody && !previous.custody.closed) {
            forgetUsb(previousSessionId, "cancelled");
          }
          if (signal.aborted) forgetUsb(previousSessionId);
          if (attemptedConnection && usbLive(previous)) recoveryState(previousSessionId, "waiting");
          scheduleUsb(previousSessionId);
        }
      }
    },
    async stopCurrentDevice({ sessionId, action }) {
      const target = { kind: "device-current-stop" as const, sessionId };
      if (!input.coreActions.claim(action, target))
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            message: "Current stop requires an unused action",
            detail: { kind: "permission", reason: "user-action-required" },
          },
        };
      try {
        return await recoveryDriver.occupy(sessionId, async (lane) => {
          const identity = recoveryDriver.describe(sessionId);
          if (!identity) return stale();
          const now = Date.now(),
            id = randomUUID();
          let entry: SafetyFaultEntry = {
            id,
            revision: 1,
            owner: {
              kind: "core",
              adapter: "recovery",
              hostEpoch: input.profile.hostEpoch,
              workbenchInstance: action.scope.workbenchInstance,
            },
            providerId: identity.physical.providerId,
            providerGeneration: identity.providerGeneration,
            physical: identity.physical,
            sessionId,
            operationId: id,
            operationClass: "safety-stop",
            createdAt: now,
            updatedAt: now,
            state: "pending",
            dispatch: "not-sent",
            movement: "unknown",
            stopRequested: true,
            stopConfirmation: "pending",
            cause: "none",
            resolution: null,
          };
          let journalFailed = false;
          try {
            await writeProgram(entry);
          } catch {
            // Safety stops reduce existing risk: a failed marker must not suppress
            // hardware cleanup (§7.2/§7.2.1). Run/motion still require their marker.
            journalFailed = true;
          }
          if (!journalFailed) lane.recorded?.(entry);
          const outcome = await lane.stop();
          // Do not retry publication or turn physical readback into a journaled
          // resolution after a failed (possibly still settling) initial commit.
          if (journalFailed) throw new Error("Safety-stop journal commit failed");
          const confirmed =
            !outcome.error && outcome.stopConfirmation === "confirmed" && isIdle(outcome.value);
          entry = {
            ...entry,
            revision: entry.revision + 1,
            updatedAt: Date.now(),
            dispatch: outcome.dispatch,
            state: confirmed ? "resolved" : "unconfirmed",
            stopConfirmation: confirmed ? "confirmed" : "unconfirmed",
            cause: confirmed ? "none" : "readback-failed",
            resolution: confirmed
              ? {
                  kind: "confirmed-on-original-session",
                  at: Date.now(),
                  sessionId,
                  identityEvidence: "same-session",
                }
              : null,
          };
          await writeProgram(entry);
          if (!confirmed)
            return deviceFailure(
              "PLUGIN_E_DEVICE_STOP_UNCONFIRMED",
              "readback-failed",
              outcome.dispatch,
            );
          return { ok: true as const, value: input.journal.snapshot() };
        });
      } catch (error) {
        if (error instanceof BrokerFailure) return error.result;
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_DEVICE_OPERATION",
            message: "Safety-stop journal or readback failed",
            detail: {
              kind: "device",
              reason: "journal-unwritable",
              dispatch: "unknown",
              stopConfirmation: "unconfirmed",
            },
          },
        };
      }
    },
    async subscribeCoreTelemetry({ principal, sessionId, channelIds, intervalMs, receive }) {
      assertPrincipal(principal);
      permission(principal, "devices.read");
      const current = getSession(principal, sessionId);
      ensureCapability(current, "telemetry.v1");
      if (
        channelIds.some(
          (id) => !current.sources.channels.some((channel) => channel.channelId === id),
        )
      )
        return stale();
      const valid = () => validCore(principal, current);
      const closure = { ended: false, listeners: new Set<() => void>() };
      let callerDisposed = false;
      // The ledger releases its sampler demand on every termination, including owner
      // invalidation, quota overflow and ACK timeout. Observe that existing teardown.
      const sampler = new Proxy(current.sampler, {
        get(target, property, receiver) {
          if (property === "snapshot") return () => target.snapshot();
          if (property === "subscribe")
            return (listener: Parameters<Sampler["subscribe"]>[0]) => target.subscribe(listener);
          if (property === "demand")
            return (id: string, interval: 500 | 30000) => {
              const remove = target.demand(id, interval);
              return () => {
                remove();
                if (!callerDisposed && !closure.ended) {
                  closure.ended = true;
                  for (const listener of [...closure.listeners]) {
                    try {
                      listener();
                    } catch {
                      /* A consumer cannot interrupt ledger teardown. */
                    }
                  }
                  closure.listeners.clear();
                }
              };
            };
          return Reflect.get(target, property, receiver);
        },
      });
      const subscription = coreTelemetry.subscribe({
        owner: {
          kind: "core",
          adapter: principal.adapter,
          hostEpoch: principal.hostEpoch,
          workbenchInstance: principal.workbenchInstance,
        },
        id: randomUUID(),
        sampler,
        channelIds,
        intervalMs,
        sources: () => current.sources,
        valid,
        receive,
      });
      const result: CoreTelemetrySubscription = {
        ...subscription,
        dispose: async () => {
          callerDisposed = true;
          closure.listeners.clear();
          await subscription.dispose();
        },
      };
      coreClosures.set(result, closure);
      return result;
    },
    attachChannel({ owner, principal, send }) {
      const key = resourceOwnerKey(owner),
        current = principal();
      if (
        current.kind !== "plugin" ||
        resourceOwnerKey(current.owner) !== key ||
        channels.has(key) ||
        input.requirements(owner) === null
      )
        return stale("subscription");
      let disposed = false;
      const channel = {
        owner: Object.freeze(structuredClone(owner)),
        principal,
        send,
        domains: new Set<"devices" | "ui" | "settings">(),
        retire() {
          if (disposed) return;
          disposed = true;
          events.disposeOwner(owner);
          channel.domains.clear();
        },
      };
      channels.set(key, channel);
      return {
        owner: channel.owner,
        negotiated(domain, version) {
          if (disposed || version !== 1) return stale("subscription");
          channel.domains.add(domain);
        },
        activate(id) {
          if (!disposed) events.activate(owner, id);
        },
        abandon(id) {
          events.unsubscribe(owner, id);
        },
        dispose() {
          channel.retire();
          // A failed sink keeps its owner slot until the router releases the attachment.
          if (channels.get(key) === channel) channels.delete(key);
        },
      };
    },
    async request<M extends DeviceMethod>(
      principal: Principal,
      method: M,
      params: DeviceParams<M>,
      signal: AbortSignal,
    ): Promise<DeviceResult<M>> {
      deviceRequestSchemas[method].params.parse(params);
      validateDeviceWire(`${method}.params`, params);
      try {
        const result = {
          ok: true as const,
          value: await dispatch(principal, method, params, signal),
        };
        const parsed = deviceRequestSchemas[method].result.parse(result);
        validateDeviceWire(`${method}.result`, parsed);
        if (!validDeviceResultV180(method, parsed, params))
          throw new Error("Invalid device result");
        return parsed as DeviceResult<M>;
      } catch (error) {
        if (error instanceof BrokerFailure) return error.result as DeviceResult<M>;
        if (error instanceof RpcError) throw error;
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_DEVICE_OPERATION",
            message: "Provider failed.",
            detail: {
              kind: "device",
              reason: "provider-failure",
              dispatch: "unknown",
              stopConfirmation: "unconfirmed",
            },
          },
        } as DeviceResult<M>;
      }
    },
    registerProvider(provider) {
      input.profile.assertHeld();
      if (providerHeld(provider.id)) throw new Error("Previous provider retirement is pending.");
      const remove = providers.add(provider);
      const registration = providers.records.get(provider.id)!.at(-1)!;
      const binding = catalogBindings.get(provider.id);
      if (binding) {
        const registrations = providers.records.get(provider.id)!;
        if (registrations.length === 1) {
          binding.generation = registration.generation;
          binding.retired = false;
        } else binding.retired = true;
      }
      let retiring = false,
        removed = false;
      let pending: Promise<void> | undefined;
      let current: Session | null = null;
      let hadReservations = false;
      let disconnected = false;
      const admission = (allowed: boolean) => {
        if (removed || retiring) return;
        const wasHeld = providerHeld(provider.id);
        if (allowed) heldProviders.delete(registration.generation);
        else heldProviders.set(registration.generation, provider.id);
        if (!allowed)
          for (const [id, row] of lostUsb)
            if (row.providerId === provider.id && row.generation === registration.generation)
              forgetUsb(id, "cancelled", "provider-retired");
        if (wasHeld !== providerHeld(provider.id)) {
          revision++;
          changed();
        }
      };
      const retire = (): Promise<void> => {
        if (pending) return pending;
        // Publish the promise and fence before any synchronous lifecycle callback.
        let accept!: () => void, reject!: (error: unknown) => void;
        const attempt = new Promise<void>((yes, no) => {
          accept = yes;
          reject = no;
        });
        pending = attempt;
        heldProviders.set(registration.generation, provider.id);
        if (!retiring) {
          retiring = true;
          current = session?.generation === registration.generation ? session : null;
          hadReservations =
            !!current &&
            (current.hadReservations || reservations.active || coreReservations.active);
          if (binding) {
            binding.retired = true;
            binding.ids.clear();
            binding.observation = null;
          }
        }
        const work = async () => {
          // Initialization owns its withdrawal cleanup. Its failure is reflected
          // in the lane/retained native close, never turned into a clean receipt.
          if (current?.initialization)
            await bounded(
              current.initialization.catch(() => {}),
              15000,
            );
          // Reuse the participant's original session receipt and recovery evidence.
          const device = (async () =>
            resources.retireProvider(provider.id, registration.generation))();
          const storage = current
            ? settleProviderRetirementLifecycle(
                resources,
                current.snapshot.sessionId,
                hadReservations || !!current.quiescence?.ended.length,
              )
            : Promise.resolve();
          const [deviceResult, storageResult] = await Promise.allSettled([device, storage]);
          const errors: unknown[] = [];
          if (deviceResult.status === "rejected") errors.push(deviceResult.reason);
          else if (!deviceResult.value.stopConfirmed || !deviceResult.value.journalCommitted)
            errors.push(new ProviderRetirementBlocked(deviceResult.value));
          if (storageResult.status === "rejected") errors.push(storageResult.reason);
          if (errors.length === 1) throw errors[0];
          if (errors.length)
            throw new AggregateError(errors, "Provider cleanup obligations failed.");
          // A connect/discover admitted before the fence may still own native I/O.
          // Drain its real promise before disposing even when no session exists yet.
          await bounded(
            Promise.allSettled([...(providerWork.get(registration.generation) ?? [])]),
            15000,
          );
          // A settled native connect is not proof that its returned handle was
          // closed. Withdrawal retains that exact handle across failed cleanup;
          // disposing/replacing its provider would strand the only cleanup path.
          if (
            retainedConnection?.generation === registration.generation &&
            !retainedConnection.closed
          )
            throw new ProviderRetirementBlocked({
              stopConfirmed: false,
              journalCommitted: input.journal.snapshot().journalHealth === "ready",
              faultIds: [],
            });
          const ctx = contexts(samplerPrincipal, current, "connection", 15000);
          if (current && session === current && !disconnected && !current.connectionClosed) {
            const outcome = await current.provider.disconnect(current.connection.key, ctx.cleanup);
            if (outcome.error) throw new Error("Provider disconnect failed.", { cause: outcome });
            disconnected = true;
          }
          await provider.dispose(ctx.cleanup);
          if (current && session === current) {
            current.unregister();
            session = null;
          }
          remove();
          if (catalogBindings.get(provider.id) === binding) catalogBindings.delete(provider.id);
          removed = true;
          retainedRecoveryEvidence.delete(registration.generation);
          heldProviders.delete(registration.generation);
          revision++;
          changed();
        };
        void work().then(accept, reject);
        revision++;
        changed();
        // Synchronous legacy callers may ignore the result. Preserve rejection for
        // awaiters, retain the registration, and permit only an explicit retry.
        void attempt.catch(() => {
          if (pending === attempt) pending = undefined;
        });
        return attempt;
      };
      const unregister = Object.assign(
        () => {
          void retire();
        },
        {
          retirement: { admission, retire },
        },
      );
      revision++;
      changed();
      return unregister;
    },
    async begin({ principal, sessionId, operationClass, signal }) {
      assertPrincipal(principal);
      if (signal.aborted)
        throw new RpcError(RPC_ERRORS.requestCancelled, "Cancelled before admission.");
      permission(principal, operationClass === "file-read" ? "devices.read" : "devices.control");
      const current = getSession(principal, sessionId),
        id = randomUUID();
      gate(principal, operationClass, sessionId, "admission");
      current.lane.reserve(id);
      const hardDeadline = input.now() + 600000;
      let confirmationDeadline = Math.min(hardDeadline, input.now() + 120000),
        closed = false,
        executionAdmitted = false,
        launched = false;
      const assertPlan = () => {
        if (
          closed ||
          (!executionAdmitted &&
            (input.now() >= hardDeadline || input.now() >= confirmationDeadline))
        )
          return deviceFailure("PLUGIN_E_TIMEOUT", "deadline");
      };
      // Confirmation clocks bound planning only. Every execution exchange still uses
      // ExchangeLane's 5 s / 10 s budget and the same authority/cancellation checks.
      const ctx = contexts(principal, current, operationClass, 600000, id, assertPlan, 600000);
      let risk: SafetyFaultEntry | null = null;
      let inFlight: Promise<ProviderOutcome<LegacyProviderValue>> | null = null;
      let resolve!: (value: DeviceDisposition) => void;
      const done = new Promise<DeviceDisposition>((r) => {
        resolve = r;
      });
      const check = () => ctx.work.assertContinuation("file-begin");
      const finish = async () => {
        if (closed) {
          await done;
          return;
        }
        if (launched) return;
        closed = true;
        const cleanupDeadline = ctx.cleanup.deadlineMonotonicMs;
        try {
          if (inFlight)
            await bounded(
              inFlight.then(
                () => {},
                () => {},
              ),
              Math.max(1, cleanupDeadline - input.now()),
            );
          await current.lane.drain(cleanupDeadline);
          current.lane.release(id);
        } catch {
          current.lane.quarantined = true;
        } finally {
          legacy.delete(id);
          signal.removeEventListener("abort", onAbort);
          resolve({
            stopConfirmed: !current.lane.quarantined,
            journalCommitted: true,
            faultIds: current.lane.quarantined && risk ? [risk.id] : [],
          });
        }
      };
      const cancel = async () => {
        if (closed) {
          await done;
          return;
        }
        ctx.stop("cancelled", true);
        try {
          if (risk) {
            const outcome = await bounded(
              current.provider.stopAndReadback(
                current.connection.key,
                { kind: "operation", operationId: id },
                ctx.cleanup,
              ),
              Math.max(1, ctx.cleanup.deadlineMonotonicMs - input.now()),
            );
            const idle = outcome.value;
            const confirmed =
              outcome.stopConfirmation === "confirmed" &&
              !!idle &&
              idle.programStopped &&
              idle.outputs.length === 4 &&
              idle.outputs.every((o) => o.known && o.busy === false && o.speed === 0);
            risk = {
              ...risk,
              revision: risk.revision + 1,
              state: confirmed ? "resolved" : "unconfirmed",
              stopRequested: true,
              stopConfirmation: confirmed ? "confirmed" : "unconfirmed",
              updatedAt: Date.now(),
              resolution: confirmed
                ? {
                    kind: "confirmed-on-original-session",
                    at: Date.now(),
                    sessionId,
                    identityEvidence: "same-session",
                  }
                : null,
            };
            await writeProgram(risk);
            if (!confirmed) current.lane.quarantined = true;
            launched = false;
          }
          await finish();
        } catch {
          current.lane.quarantined = true;
          resolve({
            stopConfirmed: false,
            journalCommitted: false,
            faultIds: risk ? [risk.id] : [],
          });
        }
      };
      const onAbort = () => {
        void cancel();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      legacy.set(id, { principal, session: sessionId, operationClass, cancel, done });
      const operation: LegacyOperation = {
        operationId: id,
        async execute(request) {
          check();
          if (request.kind !== "list") executionAdmitted = true;
          if (
            operationClass === "file-read" &&
            request.kind !== "list" &&
            request.kind !== "download"
          )
            permissionFailure();
          if (request.kind === "run") {
            if (operationClass !== "program-launch") permissionFailure();
            const owner =
              principal.kind === "plugin"
                ? { kind: "plugin" as const, owner: principal.owner }
                : {
                    kind: "core" as const,
                    adapter: principal.adapter,
                    hostEpoch: principal.hostEpoch,
                    workbenchInstance: principal.workbenchInstance,
                  };
            risk = {
              id: randomUUID(),
              revision: 1,
              owner,
              providerId: current.provider.id,
              providerGeneration: current.generation,
              physical: current.connection.physical,
              sessionId,
              operationId: id,
              operationClass: "program-launch",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              state: "pending",
              dispatch: "not-sent",
              movement: "not-started",
              stopRequested: false,
              stopConfirmation: "not-required",
              cause: "none",
              resolution: null,
            };
            await writeProgram(risk);
            check();
          }
          if (inFlight) return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
          const execution = current.provider.legacy(current.connection.key, request, ctx.work);
          inFlight = execution;
          let result: ProviderOutcome<LegacyProviderValue>;
          try {
            result = await Promise.race([
              execution,
              done.then(() => deviceFailure("PLUGIN_E_TIMEOUT", "deadline")),
            ]);
          } finally {
            if (inFlight === execution) inFlight = null;
          }
          // Closing revokes continuation, not evidence from work already dispatched.
          // finish() bounds the wait above when the provider never settles.
          if (closed || ctx.work.cancellation.aborted) {
            if (result.error)
              throw new BrokerFailure({
                ok: false,
                error: {
                  code: "PLUGIN_E_DEVICE_OPERATION",
                  message: result.error.message,
                  detail: {
                    kind: "device",
                    reason: result.error.reason,
                    dispatch: result.dispatch,
                    stopConfirmation: result.stopConfirmation,
                  },
                },
              });
            return result;
          }
          check();
          if (risk) {
            launched = result.dispatch !== "not-sent";
            risk = {
              ...risk,
              revision: risk.revision + 1,
              state: launched ? "active-program" : "resolved",
              dispatch: result.dispatch,
              movement: launched ? "unknown" : "not-started",
              updatedAt: Date.now(),
              resolution: launched
                ? null
                : {
                    kind: "not-issued",
                    at: Date.now(),
                    sessionId,
                    identityEvidence: "same-session",
                  },
            };
            await writeProgram(risk);
          }
          return result;
        },
        renewConfirmation() {
          check();
          confirmationDeadline = Math.min(hardDeadline, input.now() + 120000);
        },
        finish,
        cancel,
      };
      legacyAdmissions.set(operation, () => {
        check();
        executionAdmitted = true;
      });
      return operation;
    },
    async legacy(principal, sessionId, request, signal) {
      const operation = await broker.begin({
        principal,
        sessionId,
        operationClass:
          request.kind === "list" || request.kind === "download"
            ? "file-read"
            : request.kind === "run"
              ? "program-launch"
              : "file-write",
        signal,
      });
      try {
        return await operation.execute(request);
      } catch (error) {
        await operation.cancel();
        throw error;
      } finally {
        await operation.finish();
      }
    },
  };
  const offAuthority = input.authority.subscribe((ref) => {
    for (const [id, row] of lostUsb)
      if (row.principal.authorityContext?.ref === ref && !usbLive(row))
        forgetUsb(id, "cancelled", "authority-lost");
  });
  const offPolicy = input.subscribeConnectionPolicy?.(() => {
    for (const [id, row] of lostUsb) {
      const policy = readRecoveryPolicy(row);
      if (!policy) continue;
      row.policy = policy;
      if (!row.policy.usbAutoReconnect) forgetUsb(id, "cancelled", "policy");
      else if (!row.pending) {
        if (row.timer) clearTimeout(row.timer);
        row.timer = null;
        scheduleUsb(id);
      }
    }
  });
  const disposeRecoveryObservers = () => {
    offAuthority();
    offPolicy?.();
  };
  sessionCatalogs.set(broker, {
    listeners: sessionObservers,
    read() {
      input.profile.assertHeld();
      return structuredClone(sessionCatalog());
    },
  });
  lifecycleListeners.set(broker, lifecycle);
  recoverySessions.set(broker, () => {
    input.profile.assertHeld();
    return session ? [structuredClone(sessionSnapshot(session))] : [];
  });
  return broker;
}
