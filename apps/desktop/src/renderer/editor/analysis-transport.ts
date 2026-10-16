import type { Diagnostic } from "../../shared/api.js";
import type { LanguageAnalysis } from "../../shared/language-types.js";
import type { LanguageStatus } from "../../shared/language-services.js";
import type { QuickFixRequest, QuickFixReply } from "../../shared/quick-fixes.js";
import type {
  AnalysisIdentity,
  LanguageFeatureQuery,
  LanguageFeatureRequest,
  LanguageFeatureReply,
} from "../../shared/language-query.js";
import {
  applyAnalysis,
  diffRecord,
  type LanguageSyncReply,
  type LanguageSyncRequest,
} from "../../shared/language-sync.js";

export type AnalysisOutcome =
  | { kind: "result"; epoch: number; analysis: LanguageAnalysis }
  | { kind: "unavailable"; epoch: number; reason: "missing" | "conflict"; language: string };
type AcceptedVersion = AnalysisIdentity & { workspaceId: string };
export class AnalysisTransport {
  private workspaceId: string | undefined;
  private epoch = 0;
  private session = "";
  private revision = 0;
  private overlays: Record<string, string> | undefined;
  private result: { version: number; analysis: LanguageAnalysis } | undefined;
  private readonly versions = new WeakMap<LanguageAnalysis, AcceptedVersion>();
  constructor(
    private readonly sync: (
      workspaceId: string,
      request: LanguageSyncRequest,
    ) => Promise<LanguageSyncReply>,
    private readonly requestFixes?: (
      workspaceId: string,
      request: QuickFixRequest,
    ) => Promise<QuickFixReply>,
    private readonly cancelFix?: (workspaceId: string, requestId: string) => Promise<void>,
    private readonly requestFeature?: (
      workspaceId: string,
      request: LanguageFeatureRequest,
    ) => Promise<LanguageFeatureReply>,
    private readonly cancelFeature?: (workspaceId: string, requestId: string) => Promise<void>,
    private readonly refreshStatus?: (workspaceId: string) => Promise<LanguageStatus>,
  ) {}
  configure(workspaceId: string, epoch: number): void {
    if (this.workspaceId === workspaceId && this.epoch === epoch) return;
    this.workspaceId = workspaceId;
    this.epoch = epoch;
    this.session = crypto.randomUUID();
    this.revision = 0;
    this.overlays = undefined;
    this.result = undefined;
  }
  private accepts(analysis: LanguageAnalysis, version: AcceptedVersion): boolean {
    return (
      this.workspaceId === version.workspaceId &&
      this.epoch === version.epoch &&
      this.session === version.session &&
      this.revision === version.revision &&
      this.result?.analysis === analysis
    );
  }
  private async query<R extends { epoch: number }>(
    analysis: LanguageAnalysis,
    signal: AbortSignal | undefined,
    send: (version: AcceptedVersion, requestId: string) => Promise<R>,
    cancel: ((workspaceId: string, requestId: string) => Promise<void>) | undefined,
    stale: () => R,
  ): Promise<R> {
    const version = this.versions.get(analysis);
    if (signal?.aborted || !version || !this.accepts(analysis, version)) return stale();
    const requestId = crypto.randomUUID();
    const pending = send(version, requestId);
    let resolveCancelled!: (reply: R) => void;
    const cancelled = new Promise<R>((resolve) => {
      resolveCancelled = resolve;
    });
    const abort = () => {
      resolveCancelled(stale());
      void cancel?.(version.workspaceId, requestId).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const reply = await Promise.race([pending, cancelled]);
      return !signal?.aborted && this.accepts(analysis, version) && reply.epoch === version.epoch
        ? reply
        : stale();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async quickFixes(
    analysis: LanguageAnalysis,
    diagnostic: Diagnostic,
    signal?: AbortSignal,
  ): Promise<QuickFixReply> {
    const stale = (): QuickFixReply => ({ kind: "stale", epoch: this.epoch });
    if (!this.requestFixes) return stale();
    return this.query(
      analysis,
      signal,
      (version, requestId) =>
        this.requestFixes!(version.workspaceId, {
          epoch: version.epoch,
          session: version.session,
          revision: version.revision,
          analysisVersion: version.analysisVersion,
          requestId,
          file: diagnostic.file,
          diagnostic: {
            source: diagnostic.source,
            code: diagnostic.code,
            range: diagnostic.range,
            ...(diagnostic.helpKey ? { helpKey: diagnostic.helpKey } : {}),
          },
        }),
      this.cancelFix,
      stale,
    );
  }
  async feature(
    analysis: LanguageAnalysis,
    query: LanguageFeatureQuery,
    signal?: AbortSignal,
  ): Promise<LanguageFeatureReply> {
    const stale = (): LanguageFeatureReply => ({ kind: "stale", epoch: this.epoch });
    if (!this.requestFeature) return stale();
    return this.query(
      analysis,
      signal,
      (version, requestId) =>
        this.requestFeature!(version.workspaceId, {
          epoch: version.epoch,
          session: version.session,
          revision: version.revision,
          analysisVersion: version.analysisVersion,
          requestId,
          query,
        }),
      this.cancelFeature,
      stale,
    );
  }
  async analyze(workspaceId: string, overlays: Record<string, string>): Promise<AnalysisOutcome> {
    if (this.workspaceId !== workspaceId || !this.epoch)
      throw new Error("Language status must be configured before analysis.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const epoch = this.epoch,
        session = this.session;
      const request: LanguageSyncRequest = {
        epoch,
        session,
        revision: this.revision + 1,
        baseRevision: this.overlays ? this.revision : null,
        overlays: diffRecord(this.overlays, overlays),
        analysisBase: this.result?.version ?? null,
      };
      this.revision = request.revision;
      this.overlays = overlays;
      try {
        const reply = await this.sync(workspaceId, request);
        if (session !== this.session || epoch !== this.epoch || request.revision !== this.revision)
          throw new Error("Diagnostics cancelled.");
        if (reply.kind === "resync") {
          this.overlays = undefined;
          this.result = undefined;
          if (this.refreshStatus) {
            const status = await this.refreshStatus(workspaceId);
            if (session !== this.session || epoch !== this.epoch)
              throw new Error("Diagnostics cancelled.");
            this.configure(workspaceId, status.epoch);
            if (status.availability.kind === "unavailable")
              return { ...status.availability, epoch: status.epoch };
          } else if (reply.epoch !== epoch) throw new Error("Diagnostics cancelled.");
          continue;
        }
        if (reply.epoch !== epoch) throw new Error("Diagnostics cancelled.");
        if (reply.kind === "unavailable") {
          this.result = undefined;
          this.overlays = undefined;
          return reply;
        }
        if (reply.session !== session || reply.revision !== request.revision)
          throw new Error("Language synchronization version mismatch.");
        this.result = applyAnalysis(this.result, reply.patch);
        this.versions.set(this.result.analysis, {
          workspaceId,
          epoch,
          session,
          revision: request.revision,
          analysisVersion: this.result.version,
        });
        return { kind: "result", epoch, analysis: this.result.analysis };
      } catch (error) {
        if (
          session === this.session &&
          epoch === this.epoch &&
          request.revision === this.revision &&
          !(error instanceof Error && /Diagnostics cancelled\./.test(error.message))
        ) {
          this.overlays = undefined;
          this.result = undefined;
        }
        throw error;
      }
    }
    throw new Error("Unable to synchronize language documents.");
  }
}
