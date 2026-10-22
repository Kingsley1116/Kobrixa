import type {
  Handle,
  Counter,
  Timestamp,
  BoundedId,
  DeviceCandidate,
  CapabilityId,
  SourceCatalog,
  TelemetryFrame,
  InputModesValue,
  ReadSnapshot,
  MotionSpec,
  MotionSnapshot,
  DispatchOutcome,
  DeviceErrorReason,
} from "@kobrixa/plugin-protocol";
import type { OperationClass, PhysicalIdentity } from "@kobrixa/plugin-runtime";
import type { RemoteEntry } from "@kobrixa/device";
// Provider-local opaque objects; only provider construction can create these.
export declare const candidateBrand: unique symbol;
export declare const sessionBrand: unique symbol;
export type ProviderCandidateKey = { readonly [candidateBrand]: true };
export type ProviderSessionKey = { readonly [sessionBrand]: true };
export type DeviceConnectionPolicy = Readonly<{
  wifiConnectTimeoutMs: 3000 | 5000 | 10000 | 30000;
  wifiHandshakeTimeoutMs: 1000 | 3000 | 5000 | 10000;
  usbAutoReconnect: boolean;
  usbRetryInterval: "backoff" | 1000 | 2000 | 5000 | 10000;
  usbRetryLimit: "unlimited" | 3 | 5 | 10;
}>;
export interface ProviderCatalogPort {
  connectionPolicy(): DeviceConnectionPolicy;
  identify(input: {
    sessionId: Handle;
    portId: BoundedId | null;
    typeId: BoundedId;
    modeId: BoundedId | null;
    component: number;
    unit: string;
  }): Handle;
}
export type LegacyProviderRequest =
  | { kind: "list"; remotePath: string }
  | {
      kind: "download";
      remotePath: string;
      sink: (bytes: Uint8Array) => Promise<void>;
      progress: (sent: number, total: number) => void;
    }
  | {
      kind: "upload";
      remotePath: string;
      size: number;
      chunks: AsyncIterable<Uint8Array>;
      progress: (sent: number, total: number) => void;
    }
  | { kind: "mkdir"; remotePath: string }
  | { kind: "rename"; remotePath: string; destination: string }
  | { kind: "delete"; remotePath: string }
  | { kind: "run"; remotePath: string };
export type LegacyProviderValue =
  | { kind: "entries"; entries: RemoteEntry[] }
  | { kind: "transfer"; transferred: number }
  | { kind: "mutation"; verified: boolean }
  | { kind: "launch"; sent: true };
export type ProviderStep =
  | "discover"
  | "connect"
  | "disconnect"
  | "read"
  | "preflight"
  | "mode-write"
  | "helper-upload"
  | "helper-run"
  | "helper-arm"
  | "motion-pulse"
  | "program-run"
  | "file-begin"
  | "file-chunk"
  | "file-mkdir"
  | "file-copy"
  | "file-remove"
  | "file-close"
  | "stop"
  | "readback";
export type ProviderOutcome<T> = {
  value: T | null;
  dispatch: DispatchOutcome;
  stopConfirmation: "not-required" | "pending" | "confirmed" | "unconfirmed";
  error: { reason: DeviceErrorReason; message: string } | null;
};
export type ProviderCandidate = {
  key: ProviderCandidateKey;
  descriptor: Omit<DeviceCandidate, "candidateId" | "expiresInMs">;
  physical: PhysicalIdentity;
};
export type ProviderConnection = {
  key: ProviderSessionKey;
  descriptor: Omit<DeviceCandidate, "candidateId" | "expiresInMs">;
  physical: PhysicalIdentity;
  capabilities: CapabilityId[];
};
export type IdleObservation = {
  programStopped: boolean;
  outputs: Array<{
    actuatorId: Handle;
    known: boolean;
    busy: boolean | null;
    speed: number | null;
  }>; // EV3 必須四個 outputs。
  observedAt: Timestamp;
};
export type MotionCompletion = {
  movement: MotionSnapshot["movement"];
  angle: number | null;
  displacement: number | null;
};
export interface BuiltinDeviceProvider {
  readonly id: string;
  readonly capabilities: readonly CapabilityId[];
  discover(ctx: ProviderOperationContext): Promise<ProviderOutcome<ProviderCandidate[]>>;
  connect(
    target: ProviderCandidateKey | { wifiAddress: string },
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<ProviderConnection>>;
  disconnect(
    session: ProviderSessionKey,
    ctx: ProviderCleanupContext,
  ): Promise<ProviderOutcome<null>>;
  describe(session: ProviderSessionKey): ProviderConnection;
  sources(
    session: ProviderSessionKey,
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<SourceCatalog>>;
  read(
    session: ProviderSessionKey,
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<TelemetryFrame>>;
  inputModes(
    session: ProviderSessionKey,
    request: { portId: BoundedId; expectedSourceRevision: Counter },
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<InputModesValue>>;
  setInputMode(
    session: ProviderSessionKey,
    request: { portId: BoundedId; expectedSourceRevision: Counter; modeId: BoundedId },
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<{ sources: SourceCatalog; snapshot: ReadSnapshot }>>;
  executeFiniteMotion(
    session: ProviderSessionKey,
    motion: MotionSpec,
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<MotionCompletion>>;
  stopAndReadback(
    session: ProviderSessionKey,
    target: { kind: "operation"; operationId: Handle } | { kind: "current-device" },
    ctx: ProviderCleanupContext,
  ): Promise<ProviderOutcome<IdleObservation>>;
  observeIdle(
    session: ProviderSessionKey,
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<IdleObservation>>;
  legacy(
    session: ProviderSessionKey,
    request: LegacyProviderRequest,
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<LegacyProviderValue>>;
  onDisconnect(
    listener: (session: ProviderSessionKey, reason: DeviceErrorReason) => void,
  ): () => void;
  releaseOperation(operationId: Handle): void;
  dispose(ctx: ProviderCleanupContext): Promise<void>;
}
// 新增；只能由 broker 建立，brand／closure 留在 main。
export interface ProviderOperationContext {
  readonly operationId: Handle;
  readonly operationClass: OperationClass;
  readonly sessionId: Handle | null; // discover／connect 尚無 session。
  readonly providerGeneration: Counter;
  readonly cancellation: AbortSignal; // 工作取消意圖，不直接作為 in-flight USB signal。
  readonly deadlineMonotonicMs: number;
  now(): number;
  assertContinuation(step: ProviderStep): void;
  shouldYield(): boolean;
  stopState(): { requested: boolean; brakeRequired: boolean };
  exchange<T>(
    step: ProviderStep,
    invoke: (transportSignal: AbortSignal, timeoutMs: number) => Promise<T>,
  ): Promise<T>;
  publishProgress(value: {
    stage: MotionSnapshot["stage"];
    elapsedMs: number;
    angle: number | null;
    displacement: number | null;
  }): void;
  requestSafetyStop(reason: DeviceErrorReason): void;
}
export interface ProviderCleanupContext {
  readonly operationId: Handle;
  readonly sessionId: Handle | null;
  readonly providerGeneration: Counter;
  readonly signal: AbortSignal; // 獨立於已取消的工作 signal。
  readonly deadlineMonotonicMs: number;
  now(): number;
  brakeRequired(): boolean;
  assertCleanup(step: "stop" | "readback" | "file-close" | "disconnect"): void;
  exchange<T>(
    step: "stop" | "readback" | "file-close" | "disconnect",
    invoke: (transportSignal: AbortSignal, timeoutMs: number) => Promise<T>,
  ): Promise<T>;
}

import { deviceFailure } from "./registry.js";
export class ExchangeLane {
  foreground: string | null = null;
  quarantined = false;
  #inflight: Promise<unknown> | null = null;
  constructor(private readonly now: () => number) {}
  get occupied(): boolean {
    return this.#inflight !== null;
  }
  reserve(id: string): void {
    if (this.foreground !== null || this.quarantined)
      return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
    this.foreground = id;
  }
  release(id: string): void {
    if (this.foreground === id && !this.#inflight && !this.quarantined) this.foreground = null;
  }
  async drain(deadline: number): Promise<void> {
    // Wait for ownership of the transport lane, not for the previous caller's
    // successful result. In particular, an aborted work exchange must not reject
    // an independent safety stop queued behind it. The bounded wait still rejects
    // and quarantines the lane if the underlying transport has not settled.
    if (this.#inflight)
      await this.#bounded(
        this.#inflight.then(
          () => {},
          () => {},
        ),
        deadline,
      );
  }
  async #bounded<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const delay = deadline - this.now();
    const remaining = Number.isNaN(delay) ? 2147483647 : Math.min(delay, 2147483647);
    if (remaining <= 0) return deviceFailure("PLUGIN_E_TIMEOUT", "deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.quarantined = true;
            reject(new Error("Provider exchange deadline"));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async exchange<T>(
    id: string,
    deadline: number,
    limit: number,
    check: () => void,
    invoke: (signal: AbortSignal, timeout: number) => Promise<T>,
  ): Promise<T> {
    if (this.foreground !== null && this.foreground !== id)
      return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
    await this.drain(deadline);
    while (this.#inflight) await this.drain(deadline);
    if (this.foreground !== null && this.foreground !== id)
      return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
    check();
    const delay = Math.min(limit, deadline - this.now());
    const timeout = Number.isNaN(delay) ? 2147483647 : Math.min(delay, 2147483647);
    if (timeout <= 0) return deviceFailure("PLUGIN_E_TIMEOUT", "deadline");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const promise = Promise.resolve().then(() => {
      check();
      return invoke(controller.signal, timeout);
    });
    this.#inflight = promise;
    void promise.then(
      () => {
        if (this.#inflight === promise) this.#inflight = null;
      },
      () => {
        if (this.#inflight === promise) this.#inflight = null;
      },
    );
    try {
      const result = await this.#bounded(promise, this.now() + timeout);
      check();
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
export function exchangeBudget(step: ProviderStep): number {
  return ["helper-upload", "file-begin", "file-chunk", "file-copy", "file-close"].includes(step)
    ? 10000
    : ["preflight", "helper-run", "helper-arm", "motion-pulse", "stop", "readback"].includes(step)
      ? 2000
      : 5000;
}
export function createContexts(input: {
  id: string;
  sessionId: string | null;
  generation: number;
  operationClass: OperationClass;
  deadline: number;
  rearmMs?: number;
  now: () => number;
  lane: ExchangeLane;
  check: () => void;
  progress: ProviderOperationContext["publishProgress"];
  onStop: (reason: DeviceErrorReason) => void;
}) {
  const cancellation = new AbortController(),
    cleanupSignal = new AbortController();
  let requested = false,
    brake = false,
    stopDeadline: number | null = null;
  const stop = (reason: DeviceErrorReason, forced: boolean) => {
    const changed = !requested || (forced && !brake);
    brake = brake || forced;
    requested = true;
    stopDeadline ??= input.now() + 15000;
    cancellation.abort();
    if (changed) input.onStop(reason);
  };
  let deadline = input.deadline;
  const check = () => {
    if (requested || cancellation.signal.aborted)
      return deviceFailure("PLUGIN_E_CANCELLED", "cancelled");
    if (input.now() >= deadline && input.rearmMs === undefined) {
      stop("deadline", true);
      return deviceFailure("PLUGIN_E_TIMEOUT", "deadline");
    }
    input.check();
  };
  const work: ProviderOperationContext = {
    operationId: input.id,
    sessionId: input.sessionId,
    providerGeneration: input.generation,
    operationClass: input.operationClass,
    cancellation: cancellation.signal,
    get deadlineMonotonicMs() {
      return input.rearmMs === undefined ? deadline : input.now() + input.rearmMs;
    },
    now: input.now,
    assertContinuation: (step) =>
      step === "file-close" ? cleanup.assertCleanup("file-close") : check(),
    shouldYield: () => requested,
    stopState: () => ({ requested, brakeRequired: brake }),
    exchange: (step, invoke) => {
      if (step === "file-close") return cleanup.exchange("file-close", invoke);
      if (input.rearmMs !== undefined) deadline = input.now() + input.rearmMs;
      return input.lane.exchange(input.id, deadline, exchangeBudget(step), check, invoke);
    },
    publishProgress: input.progress,
    requestSafetyStop: (reason) => stop(reason, true),
  };
  const cleanupCheck = () => {
    if (stopDeadline === null) stopDeadline = input.now() + 15000;
    if (input.now() >= stopDeadline)
      return deviceFailure("PLUGIN_E_DEVICE_STOP_UNCONFIRMED", "stop-deadline", "unknown");
  };
  const cleanup: ProviderCleanupContext = {
    operationId: input.id,
    sessionId: input.sessionId,
    providerGeneration: input.generation,
    signal: cleanupSignal.signal,
    get deadlineMonotonicMs() {
      return stopDeadline ?? input.now() + 15000;
    },
    now: input.now,
    brakeRequired: () => brake,
    assertCleanup: () => cleanupCheck(),
    exchange: (step, invoke) => {
      cleanupCheck();
      return input.lane.exchange(
        input.id,
        stopDeadline!,
        exchangeBudget(step),
        cleanupCheck,
        invoke,
      );
    },
  };
  return { work, cleanup, stop };
}
