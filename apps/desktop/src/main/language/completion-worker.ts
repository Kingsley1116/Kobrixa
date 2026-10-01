import type { MessagePort } from "node:worker_threads";
import { BasicPlusCompletionAnalyzer } from "@kobrixa/basic-plus";
import { loadProject, ProjectSourceCache, type SourceProject } from "@kobrixa/compiler";
import {
  applyCompletionUpdates,
  type CompletionDocument,
  type CompletionSyncReply,
  type CompletionSyncRequest,
} from "../../shared/completion-sync.js";
import type { WorkspaceProjectInput } from "../workspace/workspace.js";

export interface CompletionWorkerRequest {
  id: number;
  workspaceId: string;
  input: WorkspaceProjectInput;
  request: CompletionSyncRequest;
}
export type CompletionWorkerReply =
  { id: number; ok: true; reply: CompletionSyncReply } | { id: number; ok: false; error: string };

export function startCompletionWorker(port: MessagePort): void {
  let key = "",
    revision = 0;
  let documents = new Map<string, CompletionDocument>();
  let analyzer = new BasicPlusCompletionAnalyzer();
  let sources = new ProjectSourceCache();
  let project: SourceProject | undefined;
  let queue = Promise.resolve();
  port.on("message", (message: CompletionWorkerRequest) => {
    queue = queue.then(async () => {
      const { id, request, input, workspaceId } = message;
      try {
        const nextKey = JSON.stringify([workspaceId, input, request.session]);
        if (nextKey !== key || request.baseRevision === null) {
          if (request.baseRevision !== null) {
            port.postMessage({ id, ok: true, reply: { kind: "resync" } });
            return;
          }
          key = nextKey;
          revision = 0;
          documents = new Map();
          analyzer = new BasicPlusCompletionAnalyzer();
          sources = new ProjectSourceCache();
          project = undefined;
        }
        const next =
          (request.baseRevision === null || request.baseRevision === revision) &&
          request.revision > revision &&
          applyCompletionUpdates(documents, request.updates);
        if (!next) {
          port.postMessage({ id, ok: true, reply: { kind: "resync" } });
          return;
        }
        documents = next;
        revision = request.revision;
        // Disk discovery is needed only for a workspace refresh, not each keystroke.
        if (!project || request.refresh) {
          const loaded = await loadProject(
            input.inputPath,
            new Map(),
            input.selectedEntry,
            sources,
          );
          project = loaded.project;
          if (!project) throw new Error("Unable to load completion project.");
        }
        const content = new Map(project.sources.map((source) => [source.path, source.content]));
        for (const [file, document] of documents) content.set(file, document.text);
        const index = analyzer.analyze(
          {
            ...project,
            sources: [...content].map(([path, content]) => ({ path, content })),
          },
          new AbortController().signal,
        );
        port.postMessage({
          id,
          ok: true,
          reply: {
            kind: "result",
            session: request.session,
            revision,
            versions: Object.fromEntries(
              [...documents].map(([file, value]) => [file, value.version]),
            ),
            index,
          },
        } satisfies CompletionWorkerReply);
      } catch (error) {
        port.postMessage({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies CompletionWorkerReply);
      }
    });
  });
}
