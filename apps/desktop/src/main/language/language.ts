import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  readProjectDescription,
  requirePublished,
  type ProjectDescription,
  type PublishedDiagnostic,
} from "@kobrixa/compiler";
import type { LanguageServiceResolution } from "@kobrixa/plugin-runtime";
import { LanguageLane } from "./language-lane.js";
import { CompletionService } from "./completion.js";
import { LanguageBindings } from "../workspace/language-binding.js";
import { BUILTIN_LANGUAGE_SERVICES } from "../workspace/builtin-language-services.js";
import { resolveBuiltinLanguageService } from "../workspace/builtin-language-resolution.js";
import { ProjectLoadError } from "../workspace/project-load-error.js";
import type { WorkspaceService } from "../workspace/workspace.js";
import {
  applyAnalysis,
  emptyAnalysis,
  type LanguageSyncRequest,
  type LanguageSyncReply,
} from "../../shared/language-sync.js";
import type { CompletionSyncRequest, CompletionSyncReply } from "../../shared/completion-sync.js";
import type { LanguageAnalysis } from "../../shared/language-types.js";
import type { LanguageStatus, LanguageStatusEvent } from "../../shared/language-services.js";
import type { LanguageFeatureRequest, LanguageFeatureReply } from "../../shared/language-query.js";
import type { QuickFixRequest, QuickFixReply } from "../../shared/quick-fixes.js";
type Resolver = (language: string) => LanguageServiceResolution;
interface WorkspaceLanes {
  analysis: LanguageLane;
  completion: CompletionService;
  description?: ProjectDescription;
  inputKey: string;
  loading?: ReturnType<typeof readProjectDescription>;
  projectErrorKey?: string;
}
export class LanguageService {
  private readonly bindings = new LanguageBindings(BUILTIN_LANGUAGE_SERVICES);
  private readonly lanes = new Map<string, WorkspaceLanes>();
  private readonly listeners = new Set<(event: LanguageStatusEvent) => void>();
  private disposed = false;
  private cancellationVersion = 0;
  constructor(
    private readonly workspaces: Pick<WorkspaceService, "projectInput">,
    private readonly createWorker = () => new Worker(path.join(__dirname, "language-worker.cjs")),
    private readonly resolve: Resolver = resolveBuiltinLanguageService,
    private readonly createCompletionWorker = () =>
      new Worker(path.join(__dirname, "language-worker.cjs"), { workerData: { completion: true } }),
  ) {}
  private workspace(id: string): WorkspaceLanes {
    this.workspaces.projectInput(id);
    if (this.disposed) throw new Error("Language service is disposed.");
    let lanes = this.lanes.get(id);
    if (!lanes) {
      const restarted = () => {
        const status = this.bindings.restart(id);
        if (status) this.publish(id, status);
      };
      lanes = {
        analysis: new LanguageLane(this.workspaces, this.createWorker, restarted),
        completion: new CompletionService(this.workspaces, this.createCompletionWorker, restarted),
        inputKey: "",
      };
      this.lanes.set(id, lanes);
    }
    return lanes;
  }
  private publish(workspaceId: string, status: LanguageStatus): void {
    const lanes = this.lanes.get(workspaceId)!;
    if (status.availability.kind === "available") {
      lanes.analysis.setBinding(status.availability.binding);
      lanes.completion.setBinding(status.availability.binding);
    } else {
      lanes.analysis.reset();
      lanes.completion.reset();
    }
    for (const listener of this.listeners) listener({ workspaceId, status });
  }
  async status(workspaceId: string, refresh = false): Promise<LanguageStatus> {
    const lanes = this.workspace(workspaceId);
    const input = this.workspaces.projectInput(workspaceId);
    const inputKey = JSON.stringify(input);
    if (!lanes.loading || refresh || lanes.inputKey !== inputKey) {
      lanes.inputKey = inputKey;
      // Keep the latest read, including failures, until refresh or an input change.
      lanes.loading = readProjectDescription(input.inputPath, input.selectedEntry);
    }
    let result: Awaited<ReturnType<typeof readProjectDescription>>;
    while (true) {
      const loading: ReturnType<typeof readProjectDescription> = lanes.loading;
      try {
        result = await loading;
      } catch (error) {
        if (loading !== lanes.loading) continue;
        throw error;
      }
      if (this.disposed || this.lanes.get(workspaceId) !== lanes)
        throw new Error("Diagnostics cancelled.");
      if (loading === lanes.loading) break;
    }
    if (!result.description) {
      // A malformed project is a core loader error, not a missing language provider.
      const key = JSON.stringify(result.diagnostics);
      if (lanes.projectErrorKey !== key) {
        lanes.projectErrorKey = key;
        const invalidated = this.bindings.restart(workspaceId);
        if (invalidated) this.publish(workspaceId, invalidated);
      }
      const previous = this.bindings.get(workspaceId);
      if (previous && lanes.description) return previous;
      throw new ProjectLoadError(requirePublished(result.diagnostics));
    }
    const recovered = lanes.projectErrorKey !== undefined;
    delete lanes.projectErrorKey;
    lanes.description = result.description;
    if (recovered) {
      const invalidated = this.bindings.restart(workspaceId);
      if (invalidated) this.publish(workspaceId, invalidated);
    }
    const previous = this.bindings.get(workspaceId);
    const manifest = lanes.description.manifest;
    const status = this.bindings.select(
      workspaceId,
      manifest,
      this.resolve(manifest.language),
      lanes.inputKey,
    );
    if (previous?.epoch !== status.epoch) this.publish(workspaceId, status);
    return status;
  }
  async refresh(workspaceId?: string): Promise<void> {
    await Promise.all(
      [...this.lanes]
        .filter(([id]) => !workspaceId || id === workspaceId)
        .map(async ([id, lanes]) => {
          if (this.disposed || this.lanes.get(id) !== lanes) return;
          try {
            await this.status(id, true);
          } catch (error) {
            if (this.disposed || this.lanes.get(id) !== lanes) return;
            if (!(error instanceof ProjectLoadError)) throw error;
          }
        }),
    );
  }
  onStatus(listener: (event: LanguageStatusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async sync(workspaceId: string, update: LanguageSyncRequest): Promise<LanguageSyncReply> {
    const cancellationVersion = this.cancellationVersion;
    const current = await this.status(workspaceId);
    if (cancellationVersion !== this.cancellationVersion) throw new Error("Diagnostics cancelled.");
    const selected = this.bindings.get(workspaceId);
    if (!selected) throw new Error("Diagnostics cancelled.");
    if (selected.epoch !== current.epoch) return { kind: "resync", epoch: selected.epoch };
    if (update.epoch !== current.epoch) return { kind: "resync", epoch: current.epoch };
    if (current.availability.kind === "unavailable")
      return { ...current.availability, epoch: current.epoch };
    const reply = await this.workspace(workspaceId).analysis.sync(
      workspaceId,
      update,
      current.availability.binding,
    );
    const latest = this.bindings.get(workspaceId);
    if (!latest) throw new Error("Diagnostics cancelled.");
    if (latest.epoch !== current.epoch) return { kind: "resync", epoch: latest.epoch };
    if (reply.kind === "resync") {
      await this.status(workspaceId, true);
      const latest = this.bindings.get(workspaceId);
      if (!latest) throw new Error("Diagnostics cancelled.");
      return { kind: "resync", epoch: latest.epoch };
    }
    return reply;
  }
  async completionSync(
    workspaceId: string,
    request: CompletionSyncRequest,
  ): Promise<CompletionSyncReply> {
    const current = await this.status(workspaceId, request.refresh);
    const selected = this.bindings.get(workspaceId);
    if (!selected) throw new Error("Diagnostics cancelled.");
    if (selected.epoch !== current.epoch) return { kind: "resync", epoch: selected.epoch };
    if (request.epoch !== current.epoch) return { kind: "resync", epoch: current.epoch };
    if (current.availability.kind === "unavailable")
      return { ...current.availability, epoch: current.epoch };
    if (!current.availability.binding.capabilities.includes("completion"))
      return {
        kind: "result",
        epoch: current.epoch,
        session: request.session,
        revision: request.revision,
        versions: {},
        index: { symbols: {}, scopes: [], fileContexts: {}, contextFiles: {}, guardsByFile: {} },
      };
    const reply = await this.workspace(workspaceId).completion.sync(
      workspaceId,
      request,
      current.availability.binding,
    );
    const latest = this.bindings.get(workspaceId);
    if (!latest) throw new Error("Diagnostics cancelled.");
    if (latest.epoch !== current.epoch) return { kind: "resync", epoch: latest.epoch };
    if (reply.kind === "resync") {
      await this.status(workspaceId, true);
      const latest = this.bindings.get(workspaceId);
      if (!latest) throw new Error("Diagnostics cancelled.");
      return { kind: "resync", epoch: latest.epoch };
    }
    return reply;
  }
  async quickFixes(workspaceId: string, request: QuickFixRequest): Promise<QuickFixReply> {
    this.workspaces.projectInput(workspaceId);
    const current = this.bindings.get(workspaceId);
    if (!current || request.epoch !== current.epoch || current.availability.kind !== "available")
      return { kind: "stale", epoch: current?.epoch ?? request.epoch };
    return this.workspace(workspaceId).analysis.quickFixes(workspaceId, request);
  }
  async feature(
    workspaceId: string,
    request: LanguageFeatureRequest,
  ): Promise<LanguageFeatureReply> {
    this.workspaces.projectInput(workspaceId);
    const current = this.bindings.get(workspaceId);
    if (!current || request.epoch !== current.epoch || current.availability.kind !== "available")
      return { kind: "stale", epoch: current?.epoch ?? request.epoch };
    return this.workspace(workspaceId).analysis.feature(workspaceId, request);
  }
  cancelQuickFix(workspaceId: string, requestId: string): void {
    this.lanes.get(workspaceId)?.analysis.cancelQuickFix(workspaceId, requestId);
  }
  cancelFeature(workspaceId: string, requestId: string): void {
    this.lanes.get(workspaceId)?.analysis.cancelFeature(workspaceId, requestId);
  }
  cancel(): void {
    this.cancellationVersion++;
    for (const lane of this.lanes.values()) lane.analysis.cancel();
  }
  close(workspaceId: string): void {
    const lanes = this.lanes.get(workspaceId);
    if (lanes) {
      lanes.analysis.dispose();
      lanes.completion.dispose();
    }
    this.lanes.delete(workspaceId);
    this.bindings.forget(workspaceId);
  }
  dispose(): void {
    this.disposed = true;
    for (const lane of this.lanes.values()) {
      lane.analysis.dispose();
      lane.completion.dispose();
    }
    for (const id of this.lanes.keys()) this.bindings.forget(id);
    this.lanes.clear();
    this.listeners.clear();
  }

  private compatibilityRevision = 0;
  async analyze(workspaceId: string, overlays: Record<string, string>): Promise<LanguageAnalysis> {
    const cancellationVersion = this.cancellationVersion;
    try {
      const status = await this.status(workspaceId, true);
      if (cancellationVersion !== this.cancellationVersion)
        throw new Error("Diagnostics cancelled.");
      if (!this.bindings.get(workspaceId)) throw new Error("Diagnostics cancelled.");
      const reply = await this.sync(workspaceId, {
        epoch: status.epoch,
        session: "compatibility",
        revision: ++this.compatibilityRevision,
        baseRevision: null,
        analysisBase: null,
        overlays: { set: overlays, removed: [] },
      });
      if (reply.kind !== "result")
        throw new Error("Language service unavailable or resynchronizing.");
      return applyAnalysis(undefined, reply.patch).analysis;
    } catch (error) {
      if (!(error instanceof ProjectLoadError)) throw error;
      if (!error.diagnostics.length) throw new Error("Choose an entry file before checking.");
      return { ...emptyAnalysis(), diagnostics: requirePublished(error.diagnostics) };
    }
  }
  async diagnostics(
    workspaceId: string,
    overlays: Record<string, string>,
  ): Promise<PublishedDiagnostic[]> {
    return (await this.analyze(workspaceId, overlays)).diagnostics;
  }
}
