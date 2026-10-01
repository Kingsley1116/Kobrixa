import type { BasicPlusProjectAnalysis } from "@kobrixa/basic-plus";
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
  constructor(
    private readonly sync: (
      workspaceId: string,
      request: LanguageSyncRequest,
    ) => Promise<LanguageSyncReply>,
  ) {}
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
