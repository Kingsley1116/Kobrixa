import type { BasicPlusProjectAnalysis } from "@kobrixa/basic-plus";
import type { Diagnostic } from "@kobrixa/compiler";
import type { QuickFixRequest, QuickFixReply } from "../../shared/quick-fixes.js";
import {
  applyAnalysis,
  diffRecord,
  type LanguageSyncReply,
  type LanguageSyncRequest,
} from "../../shared/language-sync.js";

/** Ordered overlay synchronization is independent of whether a result is painted.
 * Canceled requests still advance the server's document state. */
export class AnalysisTransport {
  private workspaceId: string | undefined;
  private session = "";
  private revision = 0;
  private overlays: Record<string, string> | undefined;
  private result: { version: number; analysis: BasicPlusProjectAnalysis } | undefined;
  private readonly versions = new WeakMap<
    BasicPlusProjectAnalysis,
    {
      workspaceId: string;
      session: string;
      revision: number;
      analysisVersion: number;
    }
  >();
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
  ) {}
  async quickFixes(
    analysis: BasicPlusProjectAnalysis,
    diagnostic: Diagnostic,
    signal?: AbortSignal,
  ): Promise<QuickFixReply> {
    const version = this.versions.get(analysis);
    if (
      signal?.aborted ||
      !this.requestFixes ||
      !version ||
      this.result?.analysis !== analysis ||
      this.session !== version.session ||
      this.revision !== version.revision
    )
      return { kind: "stale" };
    const requestId = crypto.randomUUID();
    const pending = this.requestFixes(version.workspaceId, {
      requestId,
      session: version.session,
      revision: version.revision,
      analysisVersion: version.analysisVersion,
      file: diagnostic.file,
      diagnostic: {
        code: diagnostic.code,
        range: diagnostic.range,
        ...(diagnostic.helpKey ? { helpKey: diagnostic.helpKey } : {}),
      },
    });
    let resolveCancelled!: (reply: QuickFixReply) => void;
    const cancelled = new Promise<QuickFixReply>((resolve) => {
      resolveCancelled = resolve;
    });
    const abort = () => {
      resolveCancelled({ kind: "stale" });
      void this.cancelFix?.(version.workspaceId, requestId).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await Promise.race([pending, cancelled]);
      return !signal?.aborted &&
        this.result?.analysis === analysis &&
        this.session === version.session &&
        this.revision === version.revision
        ? result
        : { kind: "stale" };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async analyze(
    workspaceId: string,
    overlays: Record<string, string>,
  ): Promise<BasicPlusProjectAnalysis> {
    if (this.workspaceId !== workspaceId) {
      this.workspaceId = workspaceId;
      this.session = crypto.randomUUID();
      this.revision = 0;
      this.overlays = undefined;
      this.result = undefined;
    }
    const session = this.session;
    for (let attempt = 0; attempt < 2; attempt++) {
      const request: LanguageSyncRequest = {
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
        if (session !== this.session) throw new Error("Diagnostics cancelled.");
        if (reply.kind === "resync") {
          this.overlays = undefined;
          this.result = undefined;
          continue;
        }
        if (reply.session !== session || reply.revision !== request.revision)
          throw new Error("Language synchronization version mismatch.");
        this.result = applyAnalysis(this.result, reply.patch);
        this.versions.set(this.result.analysis, {
          workspaceId,
          session,
          revision: request.revision,
          analysisVersion: this.result.version,
        });
        return this.result.analysis;
      } catch (error) {
        // Cancellation is acknowledged by the main process after applying the
        // overlay update. Other failures have an unknown outcome: resync next.
        if (
          session === this.session &&
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
