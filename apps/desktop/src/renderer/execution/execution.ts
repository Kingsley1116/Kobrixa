import type {
  BuildEvent,
  CompileResult,
  DeviceDescriptor,
  DeviceEvent,
  Diagnostic,
  KobrixaApi,
} from "../../shared/api.js";
import type { MotorTestState } from "../../shared/motor-test.js";
import { deploymentPath } from "./build-path.js";
import type { OfflinePreviewProgram } from "../../shared/offline-preview.js";

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
  | "runSent"
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
  path: string;
  time: number;
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
        deployed?: BuildVersion | undefined;
      }
    | undefined;
  connectionNotice?: "manual-required" | "upload-required" | "retry-exhausted" | undefined;
  session?: { id: string; name: string; transport: string } | undefined;
  successfulBuild?: BuildVersion | undefined;
  deployed?: (BuildVersion & { sessionId: string }) | undefined;
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
  private logId = 0;
  private deviceLogs: OperationLog[] = [];
  private motorActivity:
    { testId: string; workspaceId: string | undefined; phases: Set<string> } | undefined;
  private working = false;
  private deviceWork = false;
  private pendingRun: ExecutionRequest | undefined;
  private waitingBuild: WaitingBuild | undefined;
  private controlBlocked = false;

  constructor(private api: KobrixaApi) {}
  getSnapshot = (): ExecutionState => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  attach(): () => void {
    this.unsubscribe = [
      this.api.build.onEvent((event) => this.onBuildEvent(event)),
      this.api.device.onEvent((event) => {
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
          event.sessionId
        ) {
          this.connectionLost(event.message ?? "EV3 disconnected.", false);
        }
      }),
    ];
    return () => {
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
  /**
   * True while in a collaboration room where another participant holds EV3
   * control. Uploads, runs, deletes and mode changes are refused; stop is not.
   */
  get deviceControlBlocked(): boolean {
    return this.controlBlocked;
  }
  setDeviceControlBlocked(blocked: boolean): void {
    if (this.controlBlocked === blocked) return;
    this.controlBlocked = blocked;
    if (blocked && this.pendingRun) this.cancelWaiting();
    else this.publish();
  }
  get locked(): boolean {
    return this.editingLocked || Boolean(this.state.fileBusy || this.state.monitorBusy);
  }
  get editingLocked(): boolean {
    return this.working || Boolean(this.pendingRun);
  }
  editingLockedFor(id: string | undefined): boolean {
    return Boolean(id && this.editingLocked && this.operationWorkspaceId === id);
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
  /** Capture the starting project once so changing tabs cannot split a test's activity. */
  recordMotorTest(state: MotorTestState): void {
    const request = state.request;
    if (!request) return;
    if (this.motorActivity?.testId !== request.testId) {
      this.motorActivity = {
        testId: request.testId,
        workspaceId: this.workspaceId,
        phases: new Set(),
      };
    }
    const messages: Partial<Record<MotorTestState["phase"], Message>> = {
      preparing: "motorPreparing",
      running: "motorStarted",
      completed: "motorCompleted",
      stopped: "motorStopped",
      timeout: "motorTimeout",
      failed: "motorFailed",
      unconfirmed: "motorUnconfirmed",
    };
    const message = messages[state.phase];
    if (!message || this.motorActivity.phases.has(state.phase)) return;
    this.motorActivity.phases.add(state.phase);
    const log: OperationLog = {
      id: ++this.logId,
      time: Date.now(),
      message,
      detail: `${String.fromCharCode(65 + request.port)} · ${request.direction * request.power}%${request.durationMs ? ` · ${request.durationMs / 1_000} s` : ""}${request.degrees ? ` · ${request.degrees}°` : ""}${state.message ? `\n${state.message}` : ""}`,
      failed:
        state.phase === "failed" || state.phase === "unconfirmed" || state.phase === "timeout",
    };
    const id = this.motorActivity.workspaceId;
    if (id) {
      const project = this.project(id);
      this.projects.set(id, { ...project, logs: [...project.logs.slice(-99), log] });
    } else this.deviceLogs = [...this.deviceLogs.slice(-99), log];
    this.publish();
  }
  private phase(phase: Phase): void {
    this.update({ phase });
    this.log(phase);
  }
  setWorkspace(id: string | undefined): void {
    if (id === this.workspaceId) return;
    this.workspaceId = id;
    this.publish();
  }
  forgetWorkspace(id: string): void {
    if (this.editingLockedFor(id)) throw new Error("Project operation is in progress.");
    this.projects.delete(id);
    if (this.state.deployed?.workspaceId === id)
      this.state = { ...this.state, deployed: undefined };
    if (this.state.recovery?.deployed?.workspaceId === id)
      this.state = { ...this.state, recovery: { ...this.state.recovery, deployed: undefined } };
    this.publish();
  }
  invalidateBuild(id = this.workspaceId): void {
    if (!id) return;
    this.projects.set(id, { ...this.project(id), successfulBuild: undefined, diagnostics: [] });
    this.publish();
  }
  clearDiagnostics(id: string): void {
    const project = this.project(id);
    if (!project.diagnostics.length) return;
    this.projects.set(id, { ...project, diagnostics: [] });
    this.publish();
  }
  cancelWaiting(): void {
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
      const path = deploymentPath(result);
      if (!path)
        throw new Error(
          result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n") ||
            "No deployable program was produced.",
        );
      const version = {
        workspaceId: request.workspaceId,
        buildId: waiting.id,
        path,
        time: Date.now(),
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
  async build(request: ExecutionRequest): Promise<void> {
    if (this.locked || request.workspaceId !== this.workspaceId) return;
    await this.buildAndMaybeRun(request, false);
  }
  async preview(request: ExecutionRequest): Promise<OfflinePreviewProgram | undefined> {
    if (this.locked || request.workspaceId !== this.workspaceId) return;
    let ir: OfflinePreviewProgram | undefined;
    await this.perform(async (generation) => {
      this.phase("saving");
      await request.saveAll();
      this.assertCurrent(generation);
      const version = await this.compile(request, true);
      this.assertCurrent(generation);
      const snapshot = await this.api.build.preview(version.buildId);
      this.assertCurrent(generation);
      ir = snapshot;
    }, request.workspaceId);
    return ir;
  }
  private async buildAndMaybeRun(request: ExecutionRequest, run: boolean): Promise<void> {
    await this.perform(
      async (generation) => {
        this.phase("saving");
        await request.saveAll();
        this.assertCurrent(generation);
        const version = await this.compile(request);
        this.assertCurrent(generation);
        if (run) {
          await this.deploy(version, generation);
          this.assertCurrent(generation);
          await this.runVersion(generation);
        }
      },
      request.workspaceId,
      run,
    );
  }
  async connect(target: DeviceDescriptor | string): Promise<void> {
    if (this.working || this.state.session) return;
    if (this.state.recovery) await this.disconnect();
    this.update({ connectionNotice: undefined });
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
    const pending = this.pendingRun;
    // Connection failures clear the intent: retries never run a robot unexpectedly.
    this.pendingRun = undefined;
    this.operationWorkspaceId = undefined;
    if (pending && this.state.session) await this.buildAndMaybeRun(pending, true);
    else this.publish();
  }
  async disconnect(): Promise<void> {
    const recovery = this.state.recovery;
    if (recovery) {
      // Clear synchronously so an in-flight restored event cannot be adopted.
      this.update({ recovery: undefined, connectionNotice: undefined });
      await this.api.device.disconnect(recovery.sessionId);
      return;
    }
    const session = this.state.session;
    if (this.locked || !session) return;
    await this.perform(async (generation) => {
      this.phase("disconnecting");
      // Clear before the backend event so an intentional disconnect is not an error.
      this.update({ session: undefined, deployed: undefined, connectionNotice: undefined });
      await this.api.device.disconnect(session.id);
      this.assertCurrent(generation);
      this.log("disconnected");
    });
  }
  private async deploy(version: BuildVersion, generation: number): Promise<void> {
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
    this.update({ deployed: { ...version, sessionId: session.id } });
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
    this.log("runSent");
  }
  async upload(): Promise<void> {
    const version = this.snapshot.successfulBuild;
    if (
      this.locked ||
      this.controlBlocked ||
      !version ||
      version.workspaceId !== this.workspaceId ||
      !this.state.session
    )
      return;
    await this.perform((generation) => this.deploy(version, generation), this.workspaceId, true);
  }
  async runDeployed(): Promise<void> {
    if (
      this.locked ||
      this.controlBlocked ||
      !this.state.deployed ||
      this.state.deployed.workspaceId !== this.workspaceId
    )
      return;
    await this.perform((generation) => this.runVersion(generation), this.workspaceId, true);
  }
  async stop(): Promise<void> {
    const session = this.state.session;
    if (this.locked || !session) return;
    await this.perform(
      async (generation) => {
        this.phase("stopping");
        await this.api.device.stop(session.id);
        this.assertCurrent(generation);
        this.log("stopped");
      },
      this.workspaceId,
      true,
    );
  }
  async deleteDeployed(): Promise<void> {
    const { session, deployed } = this.state;
    if (
      this.locked ||
      this.controlBlocked ||
      !session ||
      !deployed ||
      deployed.workspaceId !== this.workspaceId
    )
      return;
    await this.perform(
      async (generation) => {
        this.phase("deleting");
        this.update({ deployed: undefined });
        await this.api.device.delete(session.id, deployed.path);
        this.assertCurrent(generation);
        this.update({ deployed: undefined });
        this.log("deleted");
      },
      this.workspaceId,
      true,
    );
  }
}

/** Closed recovered drafts are saved too; open buffers are authoritative. */
export function filesToSave(
  drafts: Record<string, string>,
  tabs: readonly { file: string; content: string; saved: string }[],
): Array<[string, string]> {
  const files = new Map(Object.entries(drafts));
  for (const tab of tabs) {
    if (tab.content !== tab.saved || files.has(tab.file)) files.set(tab.file, tab.content);
  }
  return [...files];
}
