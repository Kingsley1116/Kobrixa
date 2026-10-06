import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { BuildArtifact, CompileResult } from "@kobrixa/compiler";
import type { WebContents } from "electron";
import type { BuildEvent } from "../../shared/api.js";
import type { WorkspaceService } from "./workspace.js";
import type { BuildReply, BuildRequest } from "./build-protocol.js";

interface BuildRecord {
  cancellation: Int32Array;
  worker?: Worker;
  artifacts: BuildArtifact[];
}

export class BuildService {
  private disposed = false;
  private activeBuilds = 0;
  get busy(): boolean {
    return this.activeBuilds > 0;
  }
  readonly #builds = new Map<string, BuildRecord>();

  constructor(
    private readonly workspaces: Pick<WorkspaceService, "project">,
    private readonly renderer: () => WebContents | undefined,
    private readonly createWorker = (request: BuildRequest): Worker =>
      new Worker(path.join(__dirname, "build-worker.cjs"), { workerData: request }),
  ) {}

  async start(workspaceId: string, overlays: Record<string, string>): Promise<string> {
    if (this.disposed) throw new Error("Build service is disposed.");
    const project = await this.workspaces.project(workspaceId, new Map(Object.entries(overlays)));
    if (this.disposed) throw new Error("Build service is disposed.");
    const buildId = randomUUID();
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const worker = this.createWorker({
      project,
      cancellation: cancellation.buffer as SharedArrayBuffer,
    });
    const record: BuildRecord = { cancellation, worker, artifacts: [] };
    this.#builds.set(buildId, record);
    this.activeBuilds++;
    const complete = (result: CompileResult) => {
      if (!record.worker) return;
      delete record.worker;
      this.activeBuilds--;
      record.artifacts = result.success ? result.artifacts : [];
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
      if (reply.type === "complete") complete(reply.result);
      else
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

  cancel(buildId: string): void {
    Atomics.store(this.require(buildId).cancellation, 0, 1);
  }

  cancelAll(): void {
    for (const record of this.#builds.values())
      if (record.worker) Atomics.store(record.cancellation, 0, 1);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    for (const record of this.#builds.values()) void record.worker?.terminate();
  }

  artifacts(buildId: string): BuildArtifact[] {
    return [...this.require(buildId).artifacts];
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
