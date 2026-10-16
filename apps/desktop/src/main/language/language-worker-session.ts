import {
  BuildError,
  diagnostic,
  loadProject,
  ProjectSourceCache,
  requirePublished,
  stampDiagnostics,
} from "@kobrixa/compiler";
import {
  applyRecord,
  diffAnalysis,
  emptyAnalysis,
  type LanguageSyncReply,
} from "../../shared/language-sync.js";
import { bindingKey, supportsFile, type LanguageBinding } from "../../shared/language-services.js";
import { sameDiagnostic, type QuickFixReply } from "../../shared/quick-fixes.js";
import type { LanguageAnalysis } from "../../shared/language-types.js";
import type { LanguageFeatureReply } from "../../shared/language-query.js";
import type { WorkspaceProjectInput } from "../workspace/workspace.js";
import type {
  DiagnosticsRequest,
  QuickFixWorkerRequest,
  FeatureWorkerRequest,
} from "./language-protocol.js";
import type {
  LanguageServiceFactory,
  LanguageAnalysisProvider,
  ProviderAnalysis,
} from "./language-provider.js";

export function cancellationSignal(buffer: SharedArrayBuffer): AbortSignal {
  const bits = new Int32Array(buffer);
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  controller.signal.throwIfAborted = () => {
    if (Atomics.load(bits, 0)) controller.abort(new Error("Diagnostics cancelled."));
    check();
  };
  return controller.signal;
}
export function publishAnalysis(raw: ProviderAnalysis, binding: LanguageBinding): LanguageAnalysis {
  try {
    return { ...raw, diagnostics: stampDiagnostics(raw.diagnostics, binding.pluginId) };
  } catch (error) {
    if (!(error instanceof BuildError) || error.code !== "BUILD1007") throw error;
    return { ...emptyAnalysis(), diagnostics: [diagnostic(error.code, error.detail)] };
  }
}
export async function loadBoundProject(
  input: WorkspaceProjectInput,
  overlays: Record<string, string>,
  binding: LanguageBinding,
  cache: ProjectSourceCache,
) {
  let languageChanged = false;
  const loaded = await loadProject(
    input.inputPath,
    new Map(Object.entries(overlays).filter(([file]) => supportsFile(binding, file))),
    input.selectedEntry,
    cache,
    (manifest) => {
      if (manifest.language !== binding.language) {
        languageChanged = true;
        throw new BuildError("BUILD1001", "Language binding changed during project loading.");
      }
      return binding.frontend;
    },
  );
  return languageChanged ? { languageChanged: true as const } : { loaded };
}

export class LanguageWorkerSession {
  private binding: LanguageBinding | undefined;
  private workspaceId = "";
  private provider: LanguageAnalysisProvider | undefined;
  private sources = new ProjectSourceCache();
  private session = "";
  private revision = 0;
  private overlays: Record<string, string> = Object.create(null);
  private history = new Map<number, LanguageAnalysis>();
  private fixes = new Map<string, QuickFixReply>();
  constructor(private readonly factories: Readonly<Record<string, LanguageServiceFactory>>) {}
  async sync(message: DiagnosticsRequest): Promise<LanguageSyncReply> {
    const { binding, workspaceId, sync, input, id } = message;
    const epoch = this.binding?.epoch ?? binding.epoch;
    if (binding.epoch < epoch || sync.epoch !== binding.epoch) return { kind: "resync", epoch };
    const changed = this.binding?.epoch !== binding.epoch || this.workspaceId !== workspaceId;
    if (changed) {
      this.dispose();
      this.binding = structuredClone(binding);
      this.workspaceId = workspaceId;
      this.provider = this.factories[bindingKey(binding)]?.createAnalysis();
      if (!this.provider) throw new Error("Language service factory is missing.");
    }
    if (
      sync.baseRevision !== null &&
      (changed ||
        this.session !== sync.session ||
        this.revision !== sync.baseRevision ||
        sync.revision <= this.revision)
    )
      return { kind: "resync", epoch: binding.epoch };
    if (!changed && this.session !== sync.session) {
      this.provider?.dispose();
      this.provider = this.factories[bindingKey(binding)]!.createAnalysis();
      this.history.clear();
      this.fixes.clear();
      this.sources = new ProjectSourceCache();
    }
    // Same-epoch cancelled requests still apply document deltas before checking cancellation.
    this.overlays = applyRecord(
      sync.baseRevision === null ? Object.create(null) : this.overlays,
      sync.overlays,
    );
    this.session = sync.session;
    this.revision = sync.revision;
    this.fixes.clear();
    const signal = cancellationSignal(message.cancellation);
    signal.throwIfAborted();
    const result = await loadBoundProject(input, this.overlays, binding, this.sources);
    if ("languageChanged" in result) return { kind: "resync", epoch: binding.epoch };
    const { loaded } = result;
    signal.throwIfAborted();
    let analysis: LanguageAnalysis;
    if (!loaded.project) {
      if (!loaded.diagnostics.length) throw new Error("Choose an entry file before checking.");
      analysis = { ...emptyAnalysis(), diagnostics: requirePublished(loaded.diagnostics) };
    } else analysis = publishAnalysis(this.provider!.analyze(loaded.project, id, signal), binding);
    signal.throwIfAborted();
    const base = sync.analysisBase === null ? undefined : this.history.get(sync.analysisBase);
    const patch = diffAnalysis(base, analysis, sync.analysisBase, id);
    this.history.set(id, analysis);
    while (this.history.size > 2) this.history.delete(this.history.keys().next().value!);
    return {
      kind: "result",
      epoch: binding.epoch,
      session: sync.session,
      revision: sync.revision,
      patch,
    };
  }
  private owns(
    workspaceId: string,
    query: { epoch: number; session: string; revision: number; analysisVersion: number },
  ): boolean {
    return (
      this.workspaceId === workspaceId &&
      this.binding?.epoch === query.epoch &&
      this.session === query.session &&
      this.revision === query.revision &&
      this.history.has(query.analysisVersion)
    );
  }
  quickFixes(message: QuickFixWorkerRequest): QuickFixReply {
    const query = message.request;
    const stale: QuickFixReply = { kind: "stale", epoch: this.binding?.epoch ?? query.epoch };
    if (!this.binding || !this.provider || !this.owns(message.workspaceId, query)) return stale;
    const published = this.history
      .get(query.analysisVersion)!
      .diagnostics.find((d) => d.file === query.file && sameDiagnostic(d, query.diagnostic));
    if (
      !published ||
      published.source !== this.binding.pluginId ||
      !supportsFile(this.binding, query.file)
    )
      return stale;
    if (!this.binding.capabilities.includes("quickFixes"))
      return { kind: "result", epoch: query.epoch, fixes: [] };
    const key = JSON.stringify([
      query.epoch,
      query.session,
      query.revision,
      query.analysisVersion,
      query.file,
      query.diagnostic,
    ]);
    try {
      const signal = cancellationSignal(message.cancellation);
      signal.throwIfAborted();
      const result =
        this.fixes.get(key) ??
        ({
          kind: "result",
          epoch: query.epoch,
          fixes: this.provider.quickFixes(query.analysisVersion, query.file, published, signal),
        } satisfies QuickFixReply);
      signal.throwIfAborted();
      this.fixes.set(key, result);
      while (this.fixes.size > 128) this.fixes.delete(this.fixes.keys().next().value!);
      return result;
    } catch {
      return stale;
    }
  }
  feature(message: FeatureWorkerRequest): LanguageFeatureReply {
    const request = message.request;
    const stale: LanguageFeatureReply = {
      kind: "stale",
      epoch: this.binding?.epoch ?? request.epoch,
    };
    const capability = request.query.kind === "renameLocation" ? "rename" : request.query.kind;
    if (
      !this.binding ||
      !this.provider ||
      !this.owns(message.workspaceId, request) ||
      !this.binding.capabilities.includes(capability) ||
      !supportsFile(this.binding, request.query.file)
    )
      return stale;
    const signal = cancellationSignal(message.cancellation);
    signal.throwIfAborted();
    const result = this.provider.query(request.analysisVersion, request.query, signal);
    signal.throwIfAborted();
    return { kind: "result", epoch: request.epoch, result };
  }
  dispose(): void {
    this.provider?.dispose();
    this.provider = undefined;
    this.sources = new ProjectSourceCache();
    this.history.clear();
    this.fixes.clear();
    this.overlays = Object.create(null);
    this.session = "";
    this.revision = 0;
  }
}
