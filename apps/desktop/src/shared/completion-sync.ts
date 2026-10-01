import type { BasicPlusCompletionIndex } from "@kobrixa/basic-plus";

export interface CompletionDocument {
  version: number;
  text: string;
}
export interface CompletionEdit {
  offset: number;
  length: number;
  text: string;
}
export type CompletionUpdate =
  | { file: string; kind: "reset"; document: CompletionDocument }
  | { file: string; kind: "remove" }
  | {
      file: string;
      kind: "edit";
      before: number;
      version: number;
      changes: CompletionEdit[];
    };
export interface CompletionSyncRequest {
  session: string;
  revision: number;
  baseRevision: number | null;
  refresh: boolean;
  updates: CompletionUpdate[];
}
export type CompletionSyncReply =
  | { kind: "resync" }
  | {
      kind: "result";
      session: string;
      revision: number;
      versions: Record<string, number>;
      index: BasicPlusCompletionIndex;
    };

/** Offsets are Monaco UTF-16 offsets; each event's edits address its old text. */
export function applyCompletionUpdates(
  previous: ReadonlyMap<string, CompletionDocument>,
  updates: CompletionUpdate[],
): Map<string, CompletionDocument> | undefined {
  const documents = new Map(previous);
  for (const update of updates) {
    if (update.kind === "remove") documents.delete(update.file);
    else if (update.kind === "reset") documents.set(update.file, { ...update.document });
    else {
      const document = documents.get(update.file);
      if (!document || document.version !== update.before || update.version <= update.before)
        return;
      let text = document.text;
      let boundary = text.length;
      for (const change of [...update.changes].sort((a, b) => b.offset - a.offset)) {
        if (change.offset < 0 || change.length < 0 || change.offset + change.length > boundary)
          return;
        text =
          text.slice(0, change.offset) + change.text + text.slice(change.offset + change.length);
        boundary = change.offset;
      }
      documents.set(update.file, { version: update.version, text });
    }
  }
  return documents;
}
