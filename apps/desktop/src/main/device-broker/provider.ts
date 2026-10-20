import type { Handle, Counter, Timestamp, BoundedId, DeviceCandidate, CapabilityId, SourceCatalog, TelemetryFrame, InputModesValue, ReadSnapshot, MotionSpec, MotionSnapshot, DispatchOutcome, DeviceErrorReason } from "@kobrixa/plugin-protocol";
import type { OperationClass, PhysicalIdentity } from "@kobrixa/plugin-runtime";
import type { RemoteEntry } from "@kobrixa/device";
// Provider-local opaque objects; only provider construction can create these.
export declare const candidateBrand: unique symbol;
export declare const sessionBrand: unique symbol;
export type ProviderCandidateKey = { readonly [candidateBrand]: true };
export type ProviderSessionKey = { readonly [sessionBrand]: true };
export type DeviceConnectionPolicy=Readonly<{
  wifiConnectTimeoutMs:3000|5000|10000|30000;
  wifiHandshakeTimeoutMs:1000|3000|5000|10000;
  usbAutoReconnect:boolean;usbRetryInterval:"backoff"|1000|2000|5000|10000;
  usbRetryLimit:"unlimited"|3|5|10;
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
