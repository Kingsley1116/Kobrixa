import { createHash, randomUUID } from "node:crypto";
import {
  channelDefinitionSchema,
  deviceRequestSchemas,
  sourceCatalogSchema,
  telemetryFrameSchema,
  validateDeviceWire,
  RpcError,
  RPC_ERRORS,
  type DeviceMethod,
  type DeviceParams,
  type DeviceResult,
  type DeviceSessionSnapshot,
  type SourceCatalog,
  type DeviceCandidate,
  type DeviceSubscriptionParams,
  type DeviceSubscriptionSnapshot,
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
import type { createDeviceResourceParticipant, ResourceDriver } from "./resource-participant.js";
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
  snapshot: DeviceSessionSnapshot;
  sources: SourceCatalog;
  connection: ProviderConnection;
  provider: BuiltinDeviceProvider;
  generation: number;
  lane: ExchangeLane;
  sampler: Sampler;
  quiescence: SessionQuiescence | null;
  users: Set<string>;
  unregister: () => void;
};
type Candidate = { candidate: ProviderCandidate; generation: number; expires: number };
const merge = async (promises: Promise<DeviceDisposition>[]): Promise<DeviceDisposition> => {
  const all = await Promise.all(promises);
  return {
    stopConfirmed: all.every((v) => v.stopConfirmed),
    journalCommitted: all.every((v) => v.journalCommitted),
    faultIds: [...new Set(all.flatMap((v) => v.faultIds))],
  };
};
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
  const coreTelemetry = new CoreTelemetryLedger(input.now);
  const changed = (sourcesChanged = false) => {
    for (const row of [...subscriptions.values()])
      if (row.params.topic === "catalog" || row.params.topic === "session")
        row.notify(sourcesChanged);
  };
  const attemptPolicies = new Map<string, ReturnType<Options["connectionPolicy"]>>();
  const lostUsb = new Map<
    string,
    {
      principal: Principal;
      providerId: string;
      generation: number;
      digest: string;
      settled: Promise<DeviceDisposition>;
      policy: ReturnType<Options["connectionPolicy"]>;
      attempts: number;
      timer: ReturnType<typeof setTimeout> | null;
      pending: boolean;
    }
  >();

  const forgetUsb = (id: string, state: "cancelled" | "exhausted" | null = "cancelled") => {
    const row = lostUsb.get(id);
    if (row?.timer) clearTimeout(row.timer);
    lostUsb.delete(id);
    if (row && state) recoveryState(id, state);
  };
  const usbLive = (row: NonNullable<ReturnType<typeof lostUsb.get>>) => {
    if (closing || !input.connectionPolicy().usbAutoReconnect) return false;
    try {
      assertPrincipal(row.principal);
      const registration = providers.get(row.providerId);
      if (registration.generation !== row.generation) return false;
      const ref = row.principal.authorityContext?.ref;
      const context = ref ? input.authority.current(row.principal, ref) : null;
      if (!context || context.state === "invalid") return false;
      gate(row.principal, "connection", null, "admission");
      return true;
    } catch {
      return false;
    }
  };
  const scheduleUsb = (id: string) => {
    const row = lostUsb.get(id);
    if (!row || row.timer || row.pending) return;
    if (!row.policy.usbAutoReconnect || !usbLive(row)) {
      forgetUsb(id);
      return;
    }
    const policy = input.connectionPolicy();
    if (policy.usbRetryLimit !== "unlimited" && row.attempts >= policy.usbRetryLimit) {
      forgetUsb(id, "exhausted");
      return;
    }
    const delay =
      policy.usbRetryInterval === "backoff"
        ? [1000, 2000, 5000][Math.min(row.attempts, 2)]!
        : policy.usbRetryInterval;
    recoveryState(id, "waiting");
    row.timer = setTimeout(() => {
      row.timer = null;
      if (!usbLive(row)) {
        forgetUsb(id);
        return;
      }
      row.attempts++;
      void broker
        .reconnectForRecovery({ previousSessionId: id, signal: new AbortController().signal })
        .finally(() => scheduleUsb(id));
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
    if (!current || current.snapshot.sessionId !== id || !current.users.has(ownerKey(principal)))
      return stale();
    if (admission) {
      assertPrincipal(principal);
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
  const intent = new IntentRegistry(input.now, (scope) => operations.stopScope(scope));
  const channels = new Map<
    string,
    {
      owner: ResourceOwner;
      principal: () => Principal;
      send: (event: Stage3EventEnvelope) => void;
      domains: Set<"devices" | "ui" | "settings">;
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
      channel.send(event);
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
  ) =>
    createContexts({
      id,
      sessionId: current?.snapshot.sessionId ?? null,
      generation: current?.generation ?? 0,
      operationClass,
      deadline: input.now() + duration,
      now: input.now,
      lane: current?.lane ?? connectionLane,
      check: () => {
        assertPrincipal(principal);
        validate();
        if (current) {
          getSession(principal, current.snapshot.sessionId);
          providers.get(current.provider.id);
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
  const finishSession = (
    current: Session,
    reason: "disconnected" | "suspended" | "core-disconnect",
  ) => {
    current.snapshot.state = reason === "disconnected" ? "disconnected" : "disconnecting";
    current.snapshot.revision++;
    current.sampler.dispose();
    if (reason === "disconnected")
      notifyLifecycle({
        kind: "lost",
        session: current.snapshot,
        message: "The EV3 connection was lost.",
      });
    changed();
    coreReservations.endSession(current.snapshot.sessionId, reason, true);
    const ended = reservations.endSession(current.snapshot.sessionId, reason, true);
    const promises = operations.stopSession(current.snapshot.sessionId);
    for (const operation of legacy.values())
      if (operation.session === current.snapshot.sessionId) {
        void operation.cancel();
        promises.push(operation.done);
      }
    return { sessionId: current.snapshot.sessionId, ended, settled: merge(promises) };
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
        const disposition = await quiescence.settled;
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
      if (session?.snapshot.sessionId !== id) return;
      session.quiescence ??= finishSession(session, "suspended");
    },
  };
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
        if (row.providerId === id && row.generation === generation) forgetUsb(ref);
      const current = session;
      if (!current || current.provider.id !== id || current.generation !== generation) return [];
      current.quiescence ??= finishSession(current, "disconnected");
      return [current.quiescence.settled];
    },
    revokeAll() {
      closing = true;
      for (const id of lostUsb.keys()) forgetUsb(id);
      coreTelemetry.dispose();
      events.dispose();
      if (!session) return [];
      session.quiescence ??= finishSession(session, "suspended");
      return [session.quiescence.settled];
    },
  };
  const resources = factories.participant(resourceDriver);
  const recoveryDriver: RecoveryDriver = {
    wallNow: () => wallNow(),
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
    async occupy(sessionId, work) {
      const current = session;
      if (!current || current.snapshot.sessionId !== sessionId) return stale();
      if (reservations.active || coreReservations.active)
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "recording");
      const id = randomUUID();
      current.lane.reserve(id);
      const originalGeneration = current.generation,
        originalKey = current.connection.key;
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
            current.connection.key !== originalKey
          )
            return stale();
        },
        progress: () => {},
        onStop: () => {},
      });
      try {
        const result = await work({
          observe: () => current.provider.observeIdle(originalKey, ctx.work),
          stop: () =>
            current.provider.stopAndReadback(originalKey, { kind: "current-device" }, ctx.cleanup),
        });
        if (typeof result === "object" && result !== null && "ok" in result && result.ok === false)
          current.lane.quarantined = true;
        return result;
      } catch (error) {
        current.lane.quarantined = true;
        throw error;
      } finally {
        await current.lane.drain(ctx.cleanup.deadlineMonotonicMs);
        current.provider.releaseOperation(id);
        current.lane.release(id);
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
    if (session?.snapshot.state === "connected") session.users.add(ownerKey(principal));
    return {
      revision,
      providers: providers.list(),
      sessions: session ? [sessionSnapshot(session)] : [],
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
      if (!session || session.snapshot.sessionId !== snapshot.sessionId)
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
      method === "devices/connect" || method === "devices/disconnect"
        ? "devices.connect"
        : method === "devices/motion/prepare" ||
            method === "devices/motion/start" ||
            method === "devices/inputModes/set"
          ? "devices.control"
          : "devices.read",
    );
    if (method === "devices/list") return list(principal);
    if (method === "devices/discover") {
      const p = parse(method),
        registration = providers.get(p.providerId),
        ctx = contexts(principal, null, "connection", 10000);
      if (!registration.provider.capabilities.includes("connection.v1"))
        return deviceFailure("PLUGIN_E_DEVICE_CAPABILITY", "unsupported-capability");
      const found = value(await registration.provider.discover(ctx.work));
      ctx.work.assertContinuation("discover");
      if (found.length > 32) return quota("candidate", 32);
      const result: DeviceCandidate[] = [];
      for (const candidate of found) {
        providers.claim(p.providerId, candidate.physical);
        providers.get(p.providerId);
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
      if (connecting || connectionLane.occupied || session?.snapshot.state === "connected")
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "connecting");
      // A pre-session timeout blocks admission only until its I/O actually settles.
      connectionLane.quarantined = false;
      connecting = true;
      try {
        const p = parse(method);
        let providerId: string,
          target: ProviderCandidate["key"] | { wifiAddress: string },
          generation: number;
        if (p.target.kind === "candidate") {
          const row = candidates.get(ownerKey(principal), p.target.candidateId);
          if (input.now() >= row.expires) return stale("candidate");
          providerId = row.candidate.descriptor.providerId;
          target = row.candidate.key;
          generation = row.generation;
          candidates.remove(p.target.candidateId);
        } else {
          providerId = p.target.providerId;
          target = { wifiAddress: p.target.address };
          generation = providers.get(providerId).generation;
        }
        const registration = providers.get(providerId);
        if (generation !== registration.generation) return stale("candidate");
        if (!registration.provider.capabilities.includes("connection.v1"))
          return deviceFailure("PLUGIN_E_DEVICE_CAPABILITY", "unsupported-capability");
        const policy = Object.freeze({ ...input.connectionPolicy() });
        attemptPolicies.set(providerId, policy);
        gate(principal, "connection", null, "admission");
        const ctx = contexts(
          principal,
          null,
          "connection",
          policy.wifiConnectTimeoutMs + policy.wifiHandshakeTimeoutMs,
          randomUUID(),
          () => {
            if (providers.get(providerId).generation !== generation) return stale();
          },
        );
        const onAbort = () => ctx.stop("cancelled", true);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        let connection: ProviderConnection;
        try {
          connection = value(await registration.provider.connect(target, ctx.work));
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
        ctx.work.assertContinuation("connect");
        providers.claim(providerId, connection.physical);
        providers.get(providerId);
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
        const sampler = new Sampler({
          sessionId: id,
          now: input.now,
          busy: () => lane.foreground !== null,
          read: async () =>
            telemetryFrameSchema.parse(
              value(
                await current.provider.read(
                  connection.key,
                  contexts(samplerPrincipal, current, "passive-read", 10000).work,
                ),
              ),
            ),
        });
        session?.unregister();
        const current: Session = {
          snapshot,
          sources: { sessionId: id, sourceRevision: 1, channels: [], actuators: [] },
          connection,
          provider: registration.provider,
          generation,
          lane,
          sampler,
          quiescence: null,
          users: new Set([ownerKey(principal), ownerKey(samplerPrincipal)]),
          unregister: () => {},
        };
        session = current;
        current.sampler.subscribe((frame) => {
          reservations.append(frame);
          coreReservations.append(frame);
        });
        try {
          current.sources = sourceCatalogSchema.parse(
            value(
              await current.provider.sources(
                connection.key,
                contexts(principal, current, "passive-read", 10000).work,
              ),
            ),
          );
          getSession(principal, id);
          snapshot.sourceRevision = current.sources.sourceRevision;
        } catch (error) {
          current.sampler.dispose();
          current.lane.quarantined = true;
          current.snapshot.state = "quarantined";
          throw error;
        }
        current.unregister = current.provider.onDisconnect((key) => {
          if (key !== connection.key) return;
          current.quiescence ??= finishSession(current, "disconnected");
          if (
            current.snapshot.transport === "usb" &&
            current.connection.physical.basis === "serial" &&
            current.connection.physical.digest !== null &&
            policy.usbAutoReconnect
          ) {
            lostUsb.set(id, {
              principal,
              providerId,
              generation,
              digest: current.connection.physical.digest,
              settled: current.quiescence.settled,
              policy,
              attempts: 0,
              timer: null,
              pending: false,
            });
            scheduleUsb(id);
          } else if (current.snapshot.transport === "usb") {
            recoveryState(id, "unavailable");
          }
          current.snapshot.state = "disconnected";
          revision++;
          changed();
        });
        revision++;
        changed();
        return { session: structuredClone(snapshot) };
      } finally {
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
        current.snapshot.sourceRevision++;
        const result = value(
          await current.provider.setInputMode(current.connection.key, modeChange, ctx.work),
        );
        ctx.work.assertContinuation("read");
        current.sources = result.sources;
        current.snapshot.sourceRevision = result.sources.sourceRevision;
        changed(true);
        return {
          ...result,
          snapshot: result.snapshot.frame
            ? current.sampler.receive(result.snapshot.frame)
            : result.snapshot,
        };
      } catch (error) {
        if (method === "devices/inputModes/set") {
          current.snapshot.sourceRevision = current.sources.sourceRevision;
          changed(true);
        }
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
    const body = { schemaVersion: 1 as const, revision: document.revision + 1, entries };
    await bounded(
      input.journal.commit({
        ...body,
        integrity: {
          algorithm: "sha256",
          digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        },
      }),
      5000,
    );
  };
  const catalogBindings = new Map<
    string,
    { generation: number | null; retired: boolean; ids: Map<string, string> }
  >();
  const providerCatalog: DeviceBrokerPort["providerCatalog"] = (providerId) => {
    if (providerId !== "kobrixa.device-ev3")
      return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "provider-disabled");
    if (catalogBindings.has(providerId))
      return deviceFailure("PLUGIN_E_PROVIDER_CONFLICT", "provider-conflict");
    const binding = {
      generation: null as number | null,
      retired: false,
      ids: new Map<string, string>(),
    };
    catalogBindings.set(providerId, binding);
    return {
      connectionPolicy: () =>
        attemptPolicies.get(providerId) ?? Object.freeze({ ...input.connectionPolicy() }),
      identify(tuple) {
        const current = session;
        if (
          binding.retired ||
          binding.generation === null ||
          !current ||
          current.provider.id !== providerId ||
          current.generation !== binding.generation ||
          tuple.sessionId !== current.snapshot.sessionId
        )
          return stale();
        const fields = channelDefinitionSchema.shape;
        for (const field of ["portId", "typeId", "modeId", "component", "unit"] as const)
          if (!fields[field].safeParse(tuple[field]).success)
            return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-contract");
        validateDeviceWire("provider.channel", tuple);
        providers.get(providerId);
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
  };
  const broker: DeviceBrokerPort & LegacyOperationPort = {
    intent,
    reservations,
    sessions,
    resources,
    recovery,
    events,
    providerCatalog,
    async reconnectForRecovery({ previousSessionId, signal }) {
      try {
        const previous = lostUsb.get(previousSessionId);
        if (!previous || previous.pending || signal.aborted || !usbLive(previous)) return stale();
        previous.pending = true;
        recoveryState(previousSessionId, "connecting");
        if (previous.timer) {
          clearTimeout(previous.timer);
          previous.timer = null;
        }
        await previous.settled;
        if (lostUsb.get(previousSessionId) !== previous || !usbLive(previous)) return stale();
        assertPrincipal(previous.principal);
        gate(previous.principal, "connection", null, "admission");
        const registration = providers.get(previous.providerId);
        if (registration.generation !== previous.generation) return stale();
        const ctx = contexts(previous.principal, null, "connection", 10000);
        const found = value(await registration.provider.discover(ctx.work));
        ctx.work.assertContinuation("discover");
        if (signal.aborted || lostUsb.get(previousSessionId) !== previous) return stale();
        const journal = await input.journal.load();
        if (
          journal.entries.some(
            (entry) =>
              entry.sessionId === previousSessionId &&
              (entry.physical.basis !== "serial" || entry.physical.digest !== previous.digest),
          )
        )
          return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "identity-ambiguous");
        const matches = found.filter(
          (candidate) =>
            candidate.descriptor.transport === "usb" &&
            candidate.physical.basis === "serial" &&
            candidate.physical.digest === previous.digest,
        );
        if (matches.length !== 1) {
          recoveryState(previousSessionId, "unavailable");
          return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "identity-ambiguous");
        }
        const candidateId = candidates.add(ownerKey(previous.principal), {
          candidate: matches[0]!,
          generation: previous.generation,
          expires: input.now() + 30000,
        });
        const connected = await broker.request(
          previous.principal,
          "devices/connect",
          { target: { kind: "candidate", candidateId } },
          signal,
        );
        if (!connected.ok) return connected;
        forgetUsb(previousSessionId, null);
        recoveryState(previousSessionId, "restored", connected.value.session);
        return { ok: true, value: { sessionId: connected.value.session.sessionId } };
      } catch (error) {
        if (error instanceof BrokerFailure) return error.result;
        throw error;
      } finally {
        const previous = lostUsb.get(previousSessionId);
        if (previous) previous.pending = false;
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
          await writeProgram(entry);
          const outcome = await lane.stop(),
            observation = outcome.value;
          const confirmed =
            outcome.stopConfirmation === "confirmed" &&
            !!observation &&
            observation.programStopped &&
            observation.outputs.length === 4 &&
            observation.outputs.every(
              (output) => output.known && output.busy === false && output.speed === 0,
            );
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
      const channel = {
        owner: Object.freeze(structuredClone(owner)),
        principal,
        send,
        domains: new Set<"devices" | "ui" | "settings">(),
      };
      channels.set(key, channel);
      let disposed = false;
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
          if (disposed) return;
          disposed = true;
          events.disposeOwner(owner);
          channel.domains.clear();
          channels.delete(key);
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
      const remove = providers.add(provider);
      const binding = catalogBindings.get(provider.id);
      if (binding) {
        const registrations = providers.records.get(provider.id)!;
        if (registrations.length === 1) {
          binding.generation = registrations[0]!.generation;
          binding.retired = false;
        } else binding.retired = true;
      }
      revision++;
      changed();
      return () => {
        if (binding) {
          binding.retired = true;
          binding.ids.clear();
        }
        catalogBindings.delete(provider.id);
        const current = session;
        if (current?.provider === provider)
          void resources.retireProvider(provider.id, current.generation);
        remove();
        revision++;
        changed();
      };
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
      const ctx = contexts(principal, current, operationClass, Infinity, id, assertPlan);
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
  lifecycleListeners.set(broker, lifecycle);
  return broker;
}
