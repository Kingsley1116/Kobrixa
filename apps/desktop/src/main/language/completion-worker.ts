import type { MessagePort } from "node:worker_threads";
import type { LanguageServiceFactory, LanguageCompletionProvider } from "./language-provider.js";
import { bindingKey, supportsFile, type LanguageBinding } from "../../shared/language-services.js";
import { cancellationSignal, loadBoundProject } from "./language-worker-session.js";
import { ProjectSourceCache, type SourceProject } from "@kobrixa/compiler";
import {
  applyCompletionUpdates,
  type CompletionDocument,
  type CompletionSyncReply,
  type CompletionSyncRequest,
} from "../../shared/completion-sync.js";
import type { WorkspaceProjectInput } from "../workspace/workspace.js";

export interface CompletionWorkerRequest {
  binding: LanguageBinding;
  cancellation: SharedArrayBuffer;
  id: number;
  workspaceId: string;
  input: WorkspaceProjectInput;
  request: CompletionSyncRequest;
}
export type CompletionWorkerReply =
  | { id: number; epoch: number; ok: true; reply: CompletionSyncReply }
  | { id: number; epoch: number; ok: false; error: string };

export function startCompletionWorker(
  port: MessagePort,
  factories: Readonly<Record<string, LanguageServiceFactory>>,
): void {
  let key = "",
    revision = 0;
  let documents = new Map<string, CompletionDocument>();
  let provider: LanguageCompletionProvider | undefined;
  let epoch = 0;
  let sources = new ProjectSourceCache();
  let project: SourceProject | undefined;
  let queue = Promise.resolve();
  port.on("message", (message: CompletionWorkerRequest) => {
    queue = queue.then(async () => {
      const { id, request, input, workspaceId, binding } = message;
      try {
        if (binding.epoch < epoch || request.epoch !== binding.epoch) {
          port.postMessage({
            id,
            epoch,
            ok: true,
            reply: { kind: "resync", epoch },
          } satisfies CompletionWorkerReply);
          return;
        }
        if (binding.epoch !== epoch) {
          provider?.dispose();
          provider = factories[bindingKey(binding)]?.createCompletion();
          epoch = binding.epoch;
          key = "";
          revision = 0;
          documents = new Map();
          sources = new ProjectSourceCache();
          project = undefined;
          if (!provider) throw new Error("Language service factory is missing.");
        }
        const signal = cancellationSignal(message.cancellation);
        const nextKey = JSON.stringify([epoch, workspaceId, input, request.session]);
        if (nextKey !== key || request.baseRevision === null) {
          if (request.baseRevision !== null) {
            port.postMessage({
              id,
              epoch,
              ok: true,
              reply: { kind: "resync", epoch },
            } satisfies CompletionWorkerReply);
            return;
          }
          key = nextKey;
          revision = 0;
          documents = new Map();
          provider?.dispose();
          provider = factories[bindingKey(binding)]!.createCompletion();
          sources = new ProjectSourceCache();
          project = undefined;
        }
        const next =
          (request.baseRevision === null || request.baseRevision === revision) &&
          request.revision > revision &&
          applyCompletionUpdates(documents, request.updates);
        if (!next) {
          port.postMessage({
            id,
            epoch,
            ok: true,
            reply: { kind: "resync", epoch },
          } satisfies CompletionWorkerReply);
          return;
        }
        documents = next;
        revision = request.revision;
        signal.throwIfAborted();
        // Disk discovery is needed only for a workspace refresh, not each keystroke.
        if (!project || request.refresh) {
          const result = await loadBoundProject(input, {}, binding, sources);
          if ("languageChanged" in result) {
            port.postMessage({
              id,
              epoch,
              ok: true,
              reply: { kind: "resync", epoch },
            } satisfies CompletionWorkerReply);
            return;
          }
          project = result.loaded.project;
          if (!project) throw new Error("Unable to load completion project.");
        }
        const content = new Map(project.sources.map((source) => [source.path, source.content]));
        for (const [file, document] of documents)
          if (supportsFile(binding, file)) content.set(file, document.text);
        signal.throwIfAborted();
        const index = provider!.analyze(
          {
            ...project,
            sources: [...content].map(([path, content]) => ({ path, content })),
          },
          signal,
        );
        signal.throwIfAborted();
        port.postMessage({
          id,
          epoch,
          ok: true,
          reply: {
            kind: "result",
            epoch,
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
          epoch,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies CompletionWorkerReply);
      }
    });
  });
  port.once("close", () => provider?.dispose());
}
