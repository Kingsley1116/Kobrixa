import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { BuildArtifact, CompileResult } from "@kobrixa/compiler";
import type { WebContents } from "electron";
import type { BuildEvent } from "../../shared/api.js";
import type { WorkspaceService } from "./workspace.js";
import type { BuildReply, BuildRequest } from "./build-protocol.js";
import type { OfflinePreviewProgram } from "../../shared/offline-preview.js";
import type { SimulationPrepareResult } from "../../shared/simulator.js";
import { snapshotSimulationAssets } from "./prepare-simulation.js";

interface BuildRecord {
  cancellation: Int32Array;
  worker?: Worker;
  artifacts: BuildArtifact[];
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
  private previewSnapshot:
    { buildId: string; program?: OfflinePreviewProgram; error?: string } | undefined;

  constructor(
    private readonly workspaces: Pick<WorkspaceService, "project">,
    private readonly renderer: () => WebContents | undefined,
    private readonly createWorker = (request: BuildRequest): Worker =>
      new Worker(path.join(__dirname, "build-worker.cjs"), { workerData: request }),
  ) {}

  async start(
    workspaceId: string,
    overlays: Record<string, string>,
    preview = false,
  ): Promise<string> {
    if (this.disposed) throw new Error("Build service is disposed.");
    const project = await this.workspaces.project(workspaceId, new Map(Object.entries(overlays)));
    if (this.disposed) throw new Error("Build service is disposed.");
    const buildId = randomUUID();
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const worker = this.createWorker({
      project,
      cancellation: cancellation.buffer as SharedArrayBuffer,
      preview,
    });
    const record: BuildRecord = { cancellation, worker, artifacts: [] };
    this.#builds.set(buildId, record);
    this.activeBuilds++;
    const complete = (
      result: CompileResult,
      program?: OfflinePreviewProgram,
      previewError?: string,
    ) => {
      if (!record.worker) return;
      delete record.worker;
      this.activeBuilds--;
      record.artifacts = result.success ? result.artifacts : [];
      if (result.success && preview && !Atomics.load(cancellation, 0))
        this.previewSnapshot = {
          buildId,
          ...(program ? { program } : {}),
          ...(previewError ? { error: previewError } : {}),
        };
      if (!this.disposed) this.send({ type: "complete", workspaceId, buildId, result });
    };
    const fail = (message: string) =>
      complete({
        success: false,
        artifacts: [],
        diagnostics: [
          {
            code: Atomics.load(cancellation, 0) ? "BUILD0001" : "BUILD9000",
            severity: "error",
            file: project.manifest.entry,
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
            message: Atomics.load(cancellation, 0) ? "Build cancelled." : message,
          },
        ],
      });
    worker.on("message", (reply: BuildReply) => {
      if (!record.worker || this.disposed) return;
      if (reply.type === "complete") complete(reply.result, reply.preview, reply.previewError);
      else if (reply.type === "progress")
        this.send({
          type: "progress",
          workspaceId,
          buildId,
          progress: { ...reply.progress, buildId },
        });
    });
    worker.once("error", (error) => fail(error.message));
    worker.once("exit", (code) => fail(`Build worker exited before completing (code ${code}).`));
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
      const project = await untilCancelled(
        this.workspaces.project(workspaceId, new Map(Object.entries(overlays))),
        signal,
      );
      signal.throwIfAborted();
      const files = await untilCancelled(snapshotSimulationAssets(project), signal);
      signal.throwIfAborted();
      const worker = this.createWorker({
        project,
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
    if (!preparation.termination)
      preparation.termination = Promise.all([
        preparation.predecessor,
        preparation.worker?.terminate().catch(() => undefined),
      ]).then(() => undefined);
    return preparation.termination;
  }

  cancel(buildId: string): void {
    Atomics.store(this.require(buildId).cancellation, 0, 1);
  }

  cancelAll(): void {
    for (const workspaceId of this.#simulations.keys()) this.cancelSimulation(workspaceId);
    for (const record of this.#builds.values())
      if (record.worker) Atomics.store(record.cancellation, 0, 1);
  }

  dispose(): void {
    this.disposed = true;
    this.previewSnapshot = undefined;
    this.cancelAll();
    for (const record of this.#builds.values()) void record.worker?.terminate();
  }

  artifacts(buildId: string): BuildArtifact[] {
    return [...this.require(buildId).artifacts];
  }

  preview(buildId: string): OfflinePreviewProgram {
    this.require(buildId);
    if (this.disposed || this.previewSnapshot?.buildId !== buildId)
      throw new Error("This build has no offline preview snapshot. Build the preview again.");
    if (!this.previewSnapshot.program)
      throw new Error(this.previewSnapshot.error ?? "No offline preview snapshot.");
    return structuredClone(this.previewSnapshot.program);
  }

  async artifactBytes(buildId: string): Promise<Uint8Array> {
    const artifact = this.require(buildId).artifacts.find((item) => item.kind === "rbf");
    if (!artifact) throw new Error("This build has no deployable .rbf artifact.");
    return readFile(artifact.path);
  }

  async deployableArtifacts(
    buildId: string,
  ): Promise<Array<{ kind: "asset" | "rbf"; path: string; remotePath: string }>> {
    const artifacts = this.require(buildId).artifacts;
    const rbf = artifacts.find((item) => item.kind === "rbf");
    if (!rbf) throw new Error("This build has no deployable .rbf artifact.");
    return [
      ...artifacts
        .filter((item) => item.kind === "asset" && item.remotePath)
        .map((item) => ({ kind: "asset" as const, path: item.path, remotePath: item.remotePath! })),
      { kind: "rbf", path: rbf.path, remotePath: path.basename(rbf.path) },
    ];
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
