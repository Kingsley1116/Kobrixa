import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  BuildError,
  failedBuild,
  readDeploymentSnapshot,
  type DeploymentFile,
  resolveInside,
  type BuildArtifact,
  type CompileResult,
  type ProjectManifest,
  type SourceProject,
} from "@kobrixa/compiler";
import type { CompilerResolution, CompilerSnapshot } from "@kobrixa/plugin-runtime";
import type { WebContents } from "electron";
import type { BuildEvent } from "../../shared/api.js";
import type { WorkspaceService } from "./workspace.js";
import type { BuildReply, BuildRequest } from "./build-protocol.js";
import type { OfflinePreviewProgram } from "../../shared/offline-preview.js";
import type { SimulationPrepareResult } from "../../shared/simulator.js";
import { snapshotSimulationAssets } from "./prepare-simulation.js";
import { resolveBuiltinCompiler } from "./builtin-compilers.js";
import { OutputQueue } from "./output-queue.js";
import { ProjectLoadError } from "./project-load-error.js";
interface BuildRecord {
  cancellation: Int32Array;
  worker?: Worker;
  finished: boolean;
  result: CompileResult;
}
interface SimulationPreparation {
  controller: AbortController;
  cancellation: Int32Array;
  predecessor: Promise<void>;
  worker?: Worker;
  termination?: Promise<void>;
}
/** Stop awaiting a cancelled read without allowing its eventual result to start compilation. */
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export class BuildService {
  private disposed = false;
  private activeBuilds = 0;
  get busy(): boolean {
    return this.activeBuilds > 0;
  }
  readonly #builds = new Map<string, BuildRecord>();
  readonly #simulations = new Map<string, SimulationPreparation>();
  readonly #queue = new OutputQueue();
  #admissions: Promise<void> = Promise.resolve();
  private previewSnapshot:
    { buildId: string; program?: OfflinePreviewProgram; error?: string } | undefined;
  constructor(
    private readonly workspaces: Pick<WorkspaceService, "project">,
    private readonly renderer: () => WebContents | undefined,
    private readonly createWorker = (request: BuildRequest): Worker =>
      new Worker(path.join(__dirname, "build-worker.cjs"), { workerData: request }),
    private readonly resolveCompiler: (
      language: string,
      target: string,
    ) => CompilerResolution = resolveBuiltinCompiler,
  ) {}
  private async capture(
    workspaceId: string,
    overlays: Record<string, string>,
    onManifest?: (manifest: ProjectManifest) => void,
  ): Promise<{ project: SourceProject; compiler: CompilerSnapshot }> {
    let snapshot: CompilerSnapshot | undefined;
    const select = (manifest: ProjectManifest) => {
      onManifest?.(manifest);
      const resolution = this.resolveCompiler(manifest.language, manifest.target);
      if (!resolution.ok) throw new BuildError(resolution.code, resolution.message);
      snapshot = resolution;
      return resolution.frontend.contribution;
    };
    const project = await this.workspaces.project(
      workspaceId,
      new Map(Object.entries(overlays)),
      select,
    );
    // 測試 workspace stub 可直接回傳 SourceProject；正式 WorkspaceService 一定呼叫 select。
    if (!snapshot) select(project.manifest);
    return { project, compiler: structuredClone(snapshot!) };
  }
  /** Project load failures arrive as complete events; start still resolves the build id. */
  async start(
    workspaceId: string,
    overlays: Record<string, string>,
    preview = false,
  ): Promise<string> {
    if (this.disposed) throw new Error("Build service is disposed.");
    const buildId = randomUUID();
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const record: BuildRecord = {
      cancellation,
      finished: false,
      result: { buildId, target: "unknown", success: false, diagnostics: [], artifacts: [] },
    };
    this.#builds.set(buildId, record);
    this.activeBuilds++;
    const complete = (
      result: CompileResult,
      program?: OfflinePreviewProgram,
      previewError?: string,
    ) => {
      // A reply, error and exit can all arrive for one worker; finish the record only once.
      if (record.finished) return;
      record.finished = true;
      delete record.worker;
      this.activeBuilds--;
      record.result = { ...result, buildId, artifacts: result.success ? result.artifacts : [] };
      if (result.success && preview && !Atomics.load(cancellation, 0))
        this.previewSnapshot = {
          buildId,
          ...(program ? { program } : {}),
          ...(previewError ? { error: previewError } : {}),
        };
      if (!this.disposed)
        this.send({ type: "complete", workspaceId, buildId, result: record.result });
    };
    let entry = "<project>";
    // Capture and enqueue in call order so a faster source read cannot jump the FIFO.
    // Admission does not await compilation, allowing different output directories to run together.
    const admission = this.#admissions.then(async () => {
      try {
        const { project, compiler } = await this.capture(workspaceId, overlays, (manifest) => {
          entry = manifest.entry;
          record.result.target = manifest.target;
        });
        entry = project.manifest.entry;
        record.result.target = project.manifest.target;
        const output = await resolveInside(project.root, project.manifest.outputDir);
        void this.#queue
          .run(output, async () => {
            if (this.disposed || Atomics.load(cancellation, 0))
              throw new DOMException("Build cancelled.", "AbortError");
            await new Promise<void>((resolve) => {
              const worker = this.createWorker({
                buildId,
                project,
                compiler,
                cancellation: cancellation.buffer as SharedArrayBuffer,
                preview,
              });
              record.worker = worker;
              const fail = (error: unknown) => {
                complete(failedBuild(buildId, project.manifest.target, error, entry));
                resolve();
              };
              worker.on("message", (reply: BuildReply) => {
                if (record.finished) return;
                if (reply.type === "complete") {
                  complete(reply.result, reply.preview, reply.previewError);
                  resolve();
                } else if (reply.type === "progress" && !this.disposed)
                  this.send({
                    type: "progress",
                    workspaceId,
                    buildId,
                    progress: { ...reply.progress, buildId },
                  });
              });
              worker.once("error", fail);
              worker.once("exit", (code) =>
                fail(
                  Atomics.load(cancellation, 0)
                    ? new DOMException("Build cancelled.", "AbortError")
                    : new Error(`Build worker exited before completing (code ${code}).`),
                ),
              );
            });
          })
          .catch((error: unknown) =>
            complete(failedBuild(buildId, record.result.target, error, entry)),
          );
      } catch (error) {
        complete(
          error instanceof ProjectLoadError
            ? { ...record.result, success: false, artifacts: [], diagnostics: error.diagnostics }
            : failedBuild(buildId, record.result.target, error, entry),
        );
      }
    });
    this.#admissions = admission.catch(() => undefined);
    await admission;
    return buildId;
  }
  async prepareSimulation(
    workspaceId: string,
    overlays: Record<string, string>,
    entries: string[],
  ): Promise<SimulationPrepareResult> {
    if (this.disposed) throw new Error("Build service is disposed.");
    const previous = this.#simulations.get(workspaceId);
    this.cancelSimulation(workspaceId);
    const preparation: SimulationPreparation = {
      controller: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(4)),
      predecessor: previous?.termination ?? Promise.resolve(),
    };
    // Reserve ownership before project/resource capture can yield to another request.
    this.#simulations.set(workspaceId, preparation);
    const signal = preparation.controller.signal;
    this.activeBuilds++;
    try {
      // A replacement must not overlap the superseded compiler's CPU work.
      await untilCancelled(preparation.predecessor, signal);
      signal.throwIfAborted();
      let captured: { project: SourceProject; compiler: CompilerSnapshot };
      try {
        captured = await untilCancelled(this.capture(workspaceId, overlays), signal);
      } catch (error) {
        if (error instanceof ProjectLoadError)
          return { success: false, diagnostics: error.diagnostics };
        if (error instanceof BuildError)
          return {
            success: false,
            diagnostics: failedBuild("simulation", "unknown", error, "<project>").diagnostics,
          };
        throw error;
      }
      const { project, compiler } = captured;
      signal.throwIfAborted();
      const files = await untilCancelled(snapshotSimulationAssets(project), signal);
      signal.throwIfAborted();
      const worker = this.createWorker({
        buildId: randomUUID(),
        project,
        compiler,
        cancellation: preparation.cancellation.buffer as SharedArrayBuffer,
        simulation: { entries, files },
      });
      preparation.worker = worker;
      return await untilCancelled(
        new Promise<SimulationPrepareResult>((resolve, reject) => {
          worker.on("message", (reply: BuildReply) => {
            if (reply.type === "simulation") resolve(reply.result);
          });
          worker.once("error", reject);
          worker.once("exit", (code) =>
            reject(new Error(`Simulation compiler exited before completing (code ${code}).`)),
          );
        }),
        signal,
      );
    } finally {
      await this.terminateSimulation(preparation);
      if (this.#simulations.get(workspaceId) === preparation) this.#simulations.delete(workspaceId);
      this.activeBuilds--;
    }
  }
  /** Also used when the renderer stops/closes a preparation; unknown workspaces are harmless. */
  cancelSimulation(workspaceId: string): void {
    const preparation = this.#simulations.get(workspaceId);
    if (!preparation) return;
    Atomics.store(preparation.cancellation, 0, 1);
    preparation.controller.abort(
      new DOMException("Simulation preparation cancelled.", "AbortError"),
    );
    void this.terminateSimulation(preparation);
  }
  private terminateSimulation(preparation: SimulationPreparation): Promise<void> {
    preparation.termination ??= Promise.all([
      preparation.predecessor,
      preparation.worker?.terminate().catch(() => undefined),
    ]).then(() => undefined);
    return preparation.termination;
  }
  cancel(buildId: string): void {
    Atomics.store(this.require(buildId).cancellation, 0, 1);
  }
  cancelAll(): void {
    for (const id of this.#simulations.keys()) this.cancelSimulation(id);
    for (const record of this.#builds.values())
      if (!record.finished) Atomics.store(record.cancellation, 0, 1);
  }
  dispose(): void {
    this.disposed = true;
    this.previewSnapshot = undefined;
    this.cancelAll();
    for (const record of this.#builds.values()) void record.worker?.terminate();
  }
  artifacts(buildId: string): BuildArtifact[] {
    return structuredClone(this.require(buildId).result.artifacts);
  }
  preview(buildId: string): OfflinePreviewProgram {
    this.require(buildId);
    if (this.disposed || this.previewSnapshot?.buildId !== buildId)
      throw new Error("This build has no offline preview snapshot. Build the preview again.");
    if (!this.previewSnapshot.program)
      throw new Error(this.previewSnapshot.error ?? "No offline preview snapshot.");
    return structuredClone(this.previewSnapshot.program);
  }
  async artifactBytes(buildId: string, signal?: AbortSignal): Promise<Uint8Array> {
    const files = await this.deployableArtifacts(buildId, signal);
    return files.find((item) => item.role === "deploy-main")!.bytes;
  }
  async deployableArtifacts(buildId: string, signal?: AbortSignal): Promise<DeploymentFile[]> {
    return readDeploymentSnapshot(this.require(buildId).result, "ev3", signal);
  }
  private require(id: string): BuildRecord {
    const record = this.#builds.get(id);
    if (!record) throw new Error("Unknown build.");
    return record;
  }
  private send(event: BuildEvent): void {
    const target = this.renderer();
    if (target && !target.isDestroyed()) target.send("build:event", event);
  }
}
