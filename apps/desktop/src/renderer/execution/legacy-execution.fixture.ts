/** Test-only W06 execution oracle from b08336b, before private connection retirement.
 * Keeps the original state machine for Run/recovery/files/stop comparisons.
 * Only the private connection oracle is retained: unexercised public catalog
 * adoption, editor helpers and build/preview/upload/delete entry points are omitted.
 * Never import this fixture from a production entry. */
import type {
  BuildEvent,
  CompileResult,
  DeviceDescriptor,
  DeviceEvent,
  Diagnostic,
  KobrixaApi,
} from "../../shared/api.js";
import { deploymentPath } from "./build-path.js";

export type LegacyExecutionApi = Omit<KobrixaApi, "device"> & {
  device: Pick<KobrixaApi["device"], "onEvent" | "disconnect" | "deploy" | "run" | "stop"> & {
    connect(target: DeviceDescriptor): Promise<string>;
    connectWifi(address: string): Promise<string>;
  };
};

/** Matches the main process rejection for collaborators without device control. */
export const DEVICE_CONTROL_DENIED = "Device control is held by another collaborator.";

export type Phase =
  | "idle"
  | "awaitingDevice"
  | "connecting"
  | "saving"
  | "building"
  | "uploading"
  | "running"
  | "stopping"
  | "deleting"
  | "disconnecting"
  | "error";
export type Message =
  | Phase
  | "built"
  | "uploaded"
  | "runStarted"
  | "stopped"
  | "deleted"
  | "connected"
  | "disconnected"
  | "cancelled"
  | "files"
  | "motorPreparing"
  | "motorStarted"
  | "motorCompleted"
  | "motorStopped"
  | "motorTimeout"
  | "motorFailed"
  | "motorUnconfirmed";
export interface OperationLog {
  id: number;
  time: number;
  message: Message;
  detail?: string | undefined;
  failed?: boolean;
}
export interface BuildVersion {
  workspaceId: string;
  buildId: string;
  time: number;
  path?: string;
  deploy?: "ev3";
  undeployableReason?: "BUILD1005";
}
export interface ExecutionState {
  operationWorkspaceId?: string | undefined;
  phase: Phase;
  fileBusy?: boolean;
  monitorBusy?: boolean;
  recovery?:
    | {
        sessionId: string;
        name: string;
        state: "waiting" | "connecting";
        deployed?: (BuildVersion & { path: string }) | undefined;
      }
    | undefined;
  connectionNotice?: "manual-required" | "upload-required" | "retry-exhausted" | undefined;
  session?: { id: string; name: string; transport: string } | undefined;
  successfulBuild?: BuildVersion | undefined;
  deployed?: (BuildVersion & { sessionId: string; path: string }) | undefined;
  diagnostics: Diagnostic[];
  logs: OperationLog[];
  error?: { phase: Phase; detail: string } | undefined;
  activeBuildId?: string | undefined;
}
export interface ExecutionRequest {
  workspaceId: string;
  saveAll(): Promise<void>;
}
interface WaitingBuild {
  workspaceId: string;
  id?: string;
  events: BuildEvent[];
  cancelled: boolean;
  resolve(result: CompileResult): void;
  reject(error: Error): void;
}
class Cancelled extends Error {}

/** One serialized operation, with build events correlated even before start() resolves. */
export class ExecutionController {
  private state: ExecutionState = { phase: "idle", diagnostics: [], logs: [] };
  private snapshot = this.state;
  private operationWorkspaceId: string | undefined;
  private projects = new Map<
    string,
    Pick<ExecutionState, "successfulBuild" | "diagnostics" | "logs" | "error">
  >();
  private listeners = new Set<() => void>();
  private unsubscribe: Array<() => void> = [];
  private workspaceId: string | undefined;
  private generation = 0;
  private disconnectingSession: string | undefined;
  private logId = 0;
  private deviceLogs: OperationLog[] = [];
  private working = false;
  private deviceWork = false;
  private pendingRun: ExecutionRequest | undefined;
  private waitingBuild: WaitingBuild | undefined;
  private controlBlocked = false;
  private ownConnection = false;
  private attachment = 0;
  private intentGeneration = 0;

  constructor(private api: LegacyExecutionApi) {}
  getSnapshot = (): ExecutionState => this.snapshot;
  attach(): () => void {
    this.unsubscribe.forEach((stop) => stop());
    const attachment = ++this.attachment;
    this.unsubscribe = [
      this.api.build.onEvent((event) => this.onBuildEvent(event)),
      this.api.device.onEvent((event) => {
        if (attachment !== this.attachment) return;
        if (event.type === "usb-recovery") {
          this.onRecovery(event);
          return;
        }
        if (event.type === "files-changed" && event.sessionId === this.state.deployed?.sessionId) {
          const folder = this.state.deployed.path.slice(
            0,
            this.state.deployed.path.lastIndexOf("/"),
          );
          if (
            event.paths.some(
              (path) =>
                path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`),
            )
          )
            this.update({ deployed: undefined });
        }
        // Connection promises own connecting/connected state. Only events for the
        // current session may invalidate it; old sessions cannot affect a new one.
        if (
          event.type === "state" &&
          event.state === "disconnected" &&
          event.sessionId === this.state.session?.id &&
          event.sessionId !== this.disconnectingSession &&
          event.sessionId
        ) {
          this.connectionLost(event.message ?? "EV3 disconnected.", false);
        }
      }),
    ];
    return () => {
      if (attachment !== this.attachment) return;
      this.attachment++;
      this.cancelWaiting();
      this.unsubscribe.forEach((stop) => stop());
      this.unsubscribe = [];
    };
  }
  private connectionLost(detail: string, recovering: boolean): void {
    const localBuild = this.working && !this.deviceWork;
    const interrupted = this.deviceWork || Boolean(this.state.fileBusy || this.state.monitorBusy);
    if (!localBuild) this.generation++;
    if (this.deviceWork && this.waitingBuild) {
      this.waitingBuild.reject(new Error(detail));
      if (this.waitingBuild.id) void this.api.build.cancel(this.waitingBuild.id).catch(() => {});
    }
    this.pendingRun = undefined;
    this.update({
      session: undefined,
      deployed: undefined,
      ...(!localBuild && (interrupted || !recovering)
        ? ({ phase: "error", error: { phase: this.state.phase, detail } } as const)
        : {}),
    });
    this.log("disconnected", undefined, interrupted || !recovering);
  }
  private onRecovery(event: Extract<DeviceEvent, { type: "usb-recovery" }>): void {
    const active = event.previousSessionId === this.state.session?.id;
    const waiting = event.previousSessionId === this.state.recovery?.sessionId;
    if (!active && !waiting) return;
    if (event.state === "waiting" || event.state === "connecting") {
      const deployed = active ? this.state.deployed : this.state.recovery?.deployed;
      if (active) this.connectionLost("EV3 disconnected during the operation.", true);
      this.update({
        recovery: {
          sessionId: event.previousSessionId,
          name: event.descriptor.name,
          state: event.state,
          deployed,
        },
        connectionNotice: undefined,
      });
    } else if (event.state === "restored") {
      const deployed = this.state.recovery?.deployed;
      const verified =
        event.deployment === "verified" && deployed && deployed.buildId === event.buildId;
      this.update({
        recovery: undefined,
        session: { id: event.sessionId, name: event.descriptor.name, transport: "usb" },
        deployed: verified ? { ...deployed, sessionId: event.sessionId } : undefined,
        connectionNotice:
          event.deployment === "changed" || (deployed && !verified) ? "upload-required" : undefined,
      });
      this.log("connected");
    } else {
      if (active) this.connectionLost("EV3 disconnected.", false);
      this.update({
        recovery: undefined,
        connectionNotice:
          event.state === "exhausted"
            ? "retry-exhausted"
            : event.state === "unavailable"
              ? "manual-required"
              : undefined,
      });
    }
  }
  setDeviceControlBlocked(blocked: boolean): void {
    if (this.controlBlocked === blocked) return;
    this.controlBlocked = blocked;
    if (blocked) this.intentGeneration++;
    if (blocked && this.pendingRun) this.cancelWaiting();
    else this.publish();
  }
  get editingLocked(): boolean {
    return this.working || Boolean(this.pendingRun || this.disconnectingSession);
  }
  get locked(): boolean {
    return this.editingLocked || Boolean(this.state.fileBusy || this.state.monitorBusy);
  }
  private project(id: string | undefined = this.operationWorkspaceId ?? this.workspaceId) {
    return (id && this.projects.get(id)) || { diagnostics: [], logs: [] };
  }
  async withFiles<T>(work: () => Promise<T>, detail: string): Promise<T> {
    if (this.locked || this.state.recovery)
      throw new Error("Another EV3 operation is in progress.");
    this.update({ fileBusy: true });
    const generation = this.generation;
    try {
      const result = await work();
      if (generation === this.generation) this.log("files", detail);
      return result;
    } catch (error) {
      if (generation === this.generation)
        this.log(
          "files",
          `${detail}: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      throw error;
    } finally {
      this.update({ fileBusy: false });
    }
  }
  /** Mode changes reserve device actions without treating samples as activity. */
  async withMonitor<T>(work: () => Promise<T>): Promise<T> {
    if (this.controlBlocked) throw new Error(DEVICE_CONTROL_DENIED);
    if (this.locked || this.state.recovery)
      throw new Error("Another EV3 operation is in progress.");
    this.update({ monitorBusy: true });
    try {
      return await work();
    } finally {
      this.update({ monitorBusy: false });
    }
  }
  private publish(): void {
    const project = this.project(this.workspaceId);
    this.snapshot = {
      ...this.state,
      successfulBuild: undefined,
      error: undefined,
      ...project,
      logs: [...project.logs, ...this.deviceLogs].sort((a, b) => a.id - b.id).slice(-100),
      deployed:
        this.state.deployed?.workspaceId === this.workspaceId ? this.state.deployed : undefined,
      phase: this.editingLocked ? this.state.phase : project.error ? "error" : "idle",
      operationWorkspaceId: this.operationWorkspaceId,
    };
    this.listeners.forEach((listener) => listener());
  }
  private update(patch: Partial<ExecutionState>): void {
    this.state = { ...this.state, ...patch };
    const id = this.operationWorkspaceId ?? this.workspaceId;
    if (id) {
      const project = { ...this.project(id) };
      if ("successfulBuild" in patch) project.successfulBuild = patch.successfulBuild;
      if ("diagnostics" in patch) project.diagnostics = patch.diagnostics!;
      if ("logs" in patch) project.logs = patch.logs!;
      if ("error" in patch) project.error = patch.error;
      this.projects.set(id, project);
    }
    this.publish();
  }
  private log(message: Message, detail?: string, failed = false): void {
    this.update({
      logs: [
        ...this.project().logs.slice(-99),
        { id: ++this.logId, time: Date.now(), message, detail, failed },
      ],
    });
  }
  private phase(phase: Phase): void {
    this.update({ phase });
    this.log(phase);
  }
  setWorkspace(id: string | undefined): void {
    if (id === this.workspaceId) return;
    this.intentGeneration++;
    if (this.pendingRun && this.pendingRun.workspaceId !== id) this.cancelWaiting();
    this.workspaceId = id;
    this.publish();
  }
  cancelWaiting(): void {
    this.intentGeneration++;
    if (!this.pendingRun) return;
    this.pendingRun = undefined;
    if (this.state.phase === "awaitingDevice") this.update({ phase: "idle" });
    this.log("cancelled");
    if (!this.working) this.operationWorkspaceId = undefined;
    this.publish();
  }
  async cancelBuild(): Promise<void> {
    const waiting = this.waitingBuild;
    if (!waiting || waiting.cancelled) return;
    waiting.cancelled = true;
    if (waiting.id) {
      try {
        await this.api.build.cancel(waiting.id);
      } catch (error) {
        waiting.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  private onBuildEvent(event: BuildEvent): void {
    const waiting = this.waitingBuild;
    if (
      !waiting ||
      event.workspaceId !== waiting.workspaceId ||
      event.workspaceId !== this.operationWorkspaceId
    )
      return;
    if (!waiting.id) {
      waiting.events.push(event);
      return;
    }
    if (event.buildId !== waiting.id) return;
    if (event.type === "complete") {
      this.update({ diagnostics: event.result.diagnostics });
      if (waiting.cancelled) waiting.reject(new Cancelled());
      else waiting.resolve(event.result);
    }
  }
  private async compile(request: ExecutionRequest, preview = false): Promise<BuildVersion> {
    const generation = this.generation;
    this.phase("building");
    this.update({ diagnostics: [] });
    let resolve!: (result: CompileResult) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<CompileResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A cancellation/disconnection may happen while IPC start is still pending.
    void completed.catch(() => {});
    const waiting: WaitingBuild = {
      workspaceId: request.workspaceId,
      events: [],
      cancelled: false,
      resolve,
      reject,
    };
    this.waitingBuild = waiting;
    try {
      waiting.id = preview
        ? await this.api.build.start(request.workspaceId, {}, true)
        : await this.api.build.start(request.workspaceId, {});
      if (generation !== this.generation) {
        void this.api.build.cancel(waiting.id).catch(() => {});
        throw new Cancelled();
      }
      this.update({ activeBuildId: waiting.id });
      if (waiting.cancelled) await this.api.build.cancel(waiting.id);
      waiting.events.forEach((event) => this.onBuildEvent(event));
      waiting.events = [];
      const result = await completed;
      this.assertCurrent(generation);
      if (!result.success)
        throw new Error(
          result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") ||
            "Build failed.",
        );
      const path = deploymentPath(result);
      const version: BuildVersion = {
        workspaceId: request.workspaceId,
        buildId: waiting.id,
        time: Date.now(),
        ...(path ? { path, deploy: "ev3" as const } : { undeployableReason: "BUILD1005" as const }),
      };
      this.update({ successfulBuild: version });
      this.log("built");
      return version;
    } finally {
      if (this.waitingBuild === waiting) this.waitingBuild = undefined;
      this.update({ activeBuildId: undefined });
    }
  }
  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Cancelled();
  }
  private async perform(
    work: (generation: number) => Promise<void>,
    owner = this.workspaceId,
    usesDevice = false,
  ): Promise<void> {
    if (this.working) return;
    this.working = true;
    this.deviceWork = usesDevice;
    this.operationWorkspaceId = owner;
    const generation = this.generation;
    this.update({ error: undefined });
    try {
      await work(generation);
      this.assertCurrent(generation);
      this.update({ phase: "idle" });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof Cancelled) {
        this.update({ phase: "idle" });
        this.log("cancelled");
      } else {
        const phase = this.state.phase;
        const detail = error instanceof Error ? error.message : String(error);
        this.update({ phase: "error", error: { phase, detail } });
        this.log(phase, detail, true);
      }
    } finally {
      this.working = false;
      this.deviceWork = false;
      this.operationWorkspaceId = this.pendingRun?.workspaceId;
      this.publish();
    }
  }
  async run(request: ExecutionRequest): Promise<void> {
    if (this.locked || this.state.recovery || request.workspaceId !== this.workspaceId) return;
    if (this.controlBlocked) return;
    if (!this.state.session) {
      this.pendingRun = request;
      this.operationWorkspaceId = request.workspaceId;
      this.update({ error: undefined });
      this.phase("awaitingDevice");
      return;
    }
    await this.buildAndMaybeRun(request, true);
  }
  private async buildAndMaybeRun(
    request: ExecutionRequest,
    run: boolean,
    admission?: () => void,
  ): Promise<void> {
    await this.perform(
      async (generation) => {
        admission?.();
        this.phase("saving");
        await request.saveAll();
        this.assertCurrent(generation);
        admission?.();
        const version = await this.compile(request);
        this.assertCurrent(generation);
        admission?.();
        if (run && version.path && version.deploy === "ev3") {
          if (this.controlBlocked) throw new Error(DEVICE_CONTROL_DENIED);
          await this.stopVersion(generation);
          admission?.();
          await this.deploy(version, generation);
          this.assertCurrent(generation);
          admission?.();
          await this.runVersion(generation);
        } else if (run) {
          this.log("built", "BUILD1005: This target cannot deploy to EV3.");
        }
      },
      request.workspaceId,
      run,
    );
  }
  async connect(target: DeviceDescriptor | string): Promise<void> {
    if (this.working || this.state.session || this.disconnectingSession) return;
    if (this.state.recovery) await this.disconnect();
    // Failed cancellation restores recovery; pending cancellation must never
    // authorize a replacement connection or clear its cleanup error.
    if (this.working || this.state.session || this.state.recovery || this.disconnectingSession)
      return;
    this.update({ connectionNotice: undefined });
    this.ownConnection = true;
    try {
      await this.perform(async (generation) => {
        this.phase("connecting");
        const id =
          typeof target === "string"
            ? await this.api.device.connectWifi(target)
            : await this.api.device.connect(target);
        if (generation !== this.generation) {
          void this.api.device.disconnect(id).catch(() => {});
          throw new Cancelled();
        }
        this.update({
          session: {
            id,
            name: typeof target === "string" ? `EV3 · ${target}` : target.name,
            transport: typeof target === "string" ? "wifi" : target.transport,
          },
          deployed: undefined,
        });
        this.log("connected");
      }, this.pendingRun?.workspaceId ?? this.workspaceId);
    } finally {
      this.ownConnection = false;
    }
    const pending = this.pendingRun;
    // Connection failures clear the intent: retries never run a robot unexpectedly.
    this.pendingRun = undefined;
    this.operationWorkspaceId = undefined;
    if (pending && this.state.session) await this.buildAndMaybeRun(pending, true);
    else this.publish();
  }
  async disconnect(): Promise<void> {
    if (this.disconnectingSession) return;
    const recovery = this.state.recovery;
    if (recovery) {
      const generation = ++this.generation;
      this.disconnectingSession = recovery.sessionId;
      this.pendingRun = undefined;
      // Suppress restored events while cancellation is pending, but retain the
      // original recovery snapshot locally so failed cleanup can be retried.
      this.update({ recovery: undefined, connectionNotice: undefined, error: undefined });
      this.phase("disconnecting");
      try {
        await this.api.device.disconnect(recovery.sessionId);
        if (generation === this.generation) this.update({ phase: "idle" });
      } catch (error) {
        if (generation === this.generation && !this.state.session)
          this.update({
            recovery,
            phase: "error",
            error: {
              phase: "disconnecting",
              detail: error instanceof Error ? error.message : String(error),
            },
          });
      } finally {
        if (this.disconnectingSession === recovery.sessionId) this.disconnectingSession = undefined;
        this.publish();
      }
      return;
    }
    const session = this.state.session;
    if (!session || this.state.phase === "disconnecting") return;
    const generation = ++this.generation;
    this.disconnectingSession = session.id;
    this.pendingRun = undefined;
    this.update({ error: undefined });
    this.phase("disconnecting");
    try {
      await this.api.device.disconnect(session.id);
      if (generation !== this.generation && this.state.session?.id !== session.id) return;
      if (this.state.session?.id === session.id)
        this.update({
          session: undefined,
          deployed: undefined,
          connectionNotice: undefined,
          phase: "idle",
        });
      this.log("disconnected");
    } catch (error) {
      if (this.state.session?.id === session.id)
        this.update({
          phase: "error",
          error: {
            phase: "disconnecting",
            detail: error instanceof Error ? error.message : String(error),
          },
        });
    } finally {
      if (this.disconnectingSession === session.id) this.disconnectingSession = undefined;
      this.publish();
    }
  }
  private async deploy(version: BuildVersion, generation: number): Promise<void> {
    if (!version.path || version.deploy !== "ev3")
      throw new Error("BUILD1005: This target cannot deploy to EV3.");

    const session = this.state.session;
    if (!session) throw new Error("EV3 disconnected.");
    if (this.controlBlocked) throw new Error(DEVICE_CONTROL_DENIED);
    this.phase("uploading");
    this.update({ deployed: undefined, connectionNotice: undefined });
    await this.api.device.deploy(
      session.id,
      version.buildId,
      version.path.slice(0, version.path.lastIndexOf("/")),
    );
    this.assertCurrent(generation);
    this.update({ deployed: { ...version, path: version.path, sessionId: session.id } });
    this.log("uploaded");
  }
  private async runVersion(generation: number): Promise<void> {
    const { session, deployed } = this.state;
    if (
      !session ||
      !deployed ||
      deployed.sessionId !== session.id ||
      deployed.workspaceId !== this.operationWorkspaceId
    )
      throw new Error("Upload a program to this EV3 first.");
    if (this.controlBlocked) throw new Error(DEVICE_CONTROL_DENIED);
    this.phase("running");
    await this.api.device.run(session.id, deployed.path);
    this.assertCurrent(generation);
    this.log("runStarted");
  }
  async stop(): Promise<void> {
    const session = this.state.session;
    if (this.locked || !session) return;
    await this.perform((generation) => this.stopVersion(generation), this.workspaceId, true);
  }
  private async stopVersion(generation: number): Promise<void> {
    const session = this.state.session;
    if (!session) throw new Error("EV3 disconnected.");
    this.phase("stopping");
    await this.api.device.stop(session.id);
    this.assertCurrent(generation);
    this.log("stopped");
  }
}
