import type {
  BuildEvent,
  CompileResult,
  DeviceDescriptor,
  Diagnostic,
  KobrixaApi,
} from "../shared/api.js";
import { deploymentPath } from "./build-path.js";

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
  | "files";
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
  phase: Phase;
  fileBusy?: boolean;
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
  private listeners = new Set<() => void>();
  private unsubscribe: Array<() => void> = [];
  private workspaceId?: string;
  private generation = 0;
  private logId = 0;
  private working = false;
  private pendingRun: ExecutionRequest | undefined;
  private waitingBuild: WaitingBuild | undefined;

  constructor(private api: KobrixaApi) {}
  getSnapshot = (): ExecutionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  attach(): () => void {
    this.unsubscribe = [
      this.api.build.onEvent((event) => this.onBuildEvent(event)),
      this.api.device.onEvent((event) => {
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
          this.generation++;
          this.waitingBuild?.reject(new Error("EV3 disconnected."));
          this.pendingRun = undefined;
          this.update({
            session: undefined,
            deployed: undefined,
            phase: "error",
            error: { phase: this.state.phase, detail: event.message ?? "EV3 disconnected." },
          });
          this.log("disconnected", undefined, true);
        }
      }),
    ];
    return () => {
      this.unsubscribe.forEach((stop) => stop());
      this.unsubscribe = [];
    };
  }
  get locked(): boolean {
    return this.editingLocked || Boolean(this.state.fileBusy);
  }
  get editingLocked(): boolean {
    return this.working || Boolean(this.pendingRun);
  }
  async withFiles<T>(work: () => Promise<T>, detail: string): Promise<T> {
    if (this.locked) throw new Error("Another EV3 operation is in progress.");
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
  private update(patch: Partial<ExecutionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private log(message: Message, detail?: string, failed = false): void {
    this.update({
      logs: [
        ...this.state.logs.slice(-99),
        { id: ++this.logId, time: Date.now(), message, detail, failed },
      ],
    });
  }
  private phase(phase: Phase): void {
    this.update({ phase });
    this.log(phase);
  }
  setWorkspace(id: string): void {
    if (id === this.workspaceId) return;
    this.generation++;
    this.pendingRun = undefined;
    this.waitingBuild?.reject(new Cancelled());
    if (this.waitingBuild?.id) void this.api.build.cancel(this.waitingBuild.id).catch(() => {});
    this.workspaceId = id;
    this.update({
      phase: "idle",
      successfulBuild: undefined,
      deployed: undefined,
      diagnostics: [],
      logs: [],
      error: undefined,
      activeBuildId: undefined,
    });
  }
  invalidateBuild(): void {
    this.update({ successfulBuild: undefined });
  }
  cancelWaiting(): void {
    if (!this.pendingRun) return;
    this.pendingRun = undefined;
    if (this.state.phase === "awaitingDevice") this.update({ phase: "idle" });
    this.log("cancelled");
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
      event.workspaceId !== this.workspaceId
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
  private async compile(request: ExecutionRequest): Promise<BuildVersion> {
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
      waiting.id = await this.api.build.start(request.workspaceId, {});
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
  private async perform(work: (generation: number) => Promise<void>): Promise<void> {
    if (this.working) return;
    this.working = true;
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
        if (["uploading", "running", "stopping", "deleting", "disconnecting"].includes(phase)) {
          const session = this.state.session;
          this.update({ session: undefined, deployed: undefined });
          if (session) void this.api.device.disconnect(session.id).catch(() => {});
        }
        this.update({ phase: "error", error: { phase, detail } });
        this.log(phase, detail, true);
      }
    } finally {
      this.working = false;
      this.update({});
    }
  }
  async run(request: ExecutionRequest): Promise<void> {
    if (this.locked || request.workspaceId !== this.workspaceId) return;
    if (!this.state.session) {
      this.pendingRun = request;
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
  private async buildAndMaybeRun(request: ExecutionRequest, run: boolean): Promise<void> {
    await this.perform(async (generation) => {
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
    });
  }
  async connect(target: DeviceDescriptor | string): Promise<void> {
    if (this.working || this.state.session) return;
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
    });
    const pending = this.pendingRun;
    // Connection failures clear the intent: retries never run a robot unexpectedly.
    this.pendingRun = undefined;
    if (pending && this.state.session && pending.workspaceId === this.workspaceId)
      await this.run(pending);
    else this.update({});
  }
  async disconnect(): Promise<void> {
    const session = this.state.session;
    if (this.locked || !session) return;
    await this.perform(async (generation) => {
      this.phase("disconnecting");
      // Clear before the backend event so an intentional disconnect is not an error.
      this.update({ session: undefined, deployed: undefined });
      await this.api.device.disconnect(session.id);
      this.assertCurrent(generation);
      this.log("disconnected");
    });
  }
  private async deploy(version: BuildVersion, generation: number): Promise<void> {
    const session = this.state.session;
    if (!session) throw new Error("EV3 disconnected.");
    this.phase("uploading");
    this.update({ deployed: undefined });
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
    if (!session || !deployed || deployed.sessionId !== session.id)
      throw new Error("Upload a program to this EV3 first.");
    this.phase("running");
    await this.api.device.run(session.id, deployed.path);
    this.assertCurrent(generation);
    this.log("runSent");
  }
  async upload(): Promise<void> {
    const version = this.state.successfulBuild;
    if (this.locked || !version || !this.state.session) return;
    await this.perform((generation) => this.deploy(version, generation));
  }
  async runDeployed(): Promise<void> {
    if (this.locked || !this.state.deployed) return;
    await this.perform((generation) => this.runVersion(generation));
  }
  async stop(): Promise<void> {
    const session = this.state.session;
    if (this.locked || !session) return;
    await this.perform(async (generation) => {
      this.phase("stopping");
      await this.api.device.stop(session.id);
      this.assertCurrent(generation);
      this.log("stopped");
    });
  }
  async deleteDeployed(): Promise<void> {
    const { session, deployed } = this.state;
    if (this.locked || !session || !deployed) return;
    await this.perform(async (generation) => {
      this.phase("deleting");
      await this.api.device.delete(session.id, deployed.path);
      this.assertCurrent(generation);
      this.update({ deployed: undefined });
      this.log("deleted");
    });
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
