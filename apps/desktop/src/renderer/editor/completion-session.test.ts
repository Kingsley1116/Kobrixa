import { afterEach, expect, it, vi } from "vitest";
import type { editor, Position } from "monaco-editor";
import type { WorkspaceSummary } from "../../shared/api.js";
import {
  applyCompletionUpdates,
  type CompletionDocument,
  type CompletionSyncRequest,
  type CompletionSyncReply,
} from "../../shared/completion-sync.js";
import { CompletionSession } from "./completion-session.js";

function model(initial = "known = 1\n") {
  let text = initial,
    version = 1;
  const listeners = new Set<(event: editor.IModelContentChangedEvent) => void>();
  const value = {
    getVersionId: () => version,
    getValue: vi.fn(() => text),
    getLineContent: (line: number) => text.split("\n")[line - 1]!,
    getPositionAt: (offset: number) => {
      const lines = text.slice(0, offset).split("\n");
      return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 };
    },
    isDisposed: () => false,
    deltaDecorations: () => [],
    getDecorationRange: () => null,
    onDidChangeContent: (listener: (event: editor.IModelContentChangedEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  } as unknown as editor.ITextModel;
  const append = (added: string) => {
    const line = text.split("\n").length,
      column = text.split("\n").at(-1)!.length + 1;
    const event = {
      versionId: ++version,
      isFlush: false,
      isEolChange: false,
      changes: [
        {
          rangeOffset: text.length,
          rangeLength: 0,
          text: added,
          range: {
            startLineNumber: line,
            endLineNumber: line,
            startColumn: column,
            endColumn: column,
          },
        },
      ],
    } as editor.IModelContentChangedEvent;
    text += added;
    for (const listener of listeners) listener(event);
  };
  return { value, append };
}
const workspace = (id = "project") => ({ id, files: ["main.bp"], drafts: {} }) as WorkspaceSummary;
const position = { lineNumber: 2, column: 1 } as Position;
function reply(
  request: CompletionSyncRequest,
  documents: Map<string, CompletionDocument>,
): CompletionSyncReply {
  return {
    kind: "result",
    session: request.session,
    revision: request.revision,
    versions: Object.fromEntries([...documents].map(([file, value]) => [file, value.version])),
    index: {
      symbols: {
        known: {
          id: "known",
          context: "main.bp",
          scopeId: "global",
          name: "known",
          kind: "variable",
          scope: "global",
          type: "number",
          aliases: ["known"],
        },
      },
      scopes: [],
      guardsByFile: {},
      fileContexts: { "main.bp": "main.bp" },
      contextFiles: { "main.bp": ["main.bp"] },
    },
  };
}
afterEach(() => vi.useRealTimers());

it("discards an in-flight index after a workspace switch or model replacement", async () => {
  vi.useFakeTimers();
  const pending: Array<() => void> = [];
  const sync = vi.fn(
    (_workspace: string, request: CompletionSyncRequest) =>
      new Promise<CompletionSyncReply>((resolve) =>
        pending.push(() =>
          resolve(reply(request, applyCompletionUpdates(new Map(), request.updates)!)),
        ),
      ),
  );
  const session = new CompletionSession(sync),
    old = model(),
    next = model("other = 2\n");
  session.configure(workspace());
  session.bind("main.bp", old.value);
  await vi.advanceTimersByTimeAsync(50);
  session.configure(workspace("other"));
  session.bind("main.bp", next.value);
  pending[0]!();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.symbols("main.bp", position)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(50);
  expect(sync.mock.calls[1]![1].session).not.toBe(sync.mock.calls[0]![1].session);
  session.unbind("main.bp", next.value);
  session.bind("main.bp", model("replacement = 3\n").value);
  pending[1]!();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.symbols("main.bp", position)).toBeUndefined();
  session.dispose();
});

it("does not adopt an older index across a structural edit while it is computing", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const sync = vi.fn(
    (_workspace: string, request: CompletionSyncRequest) =>
      new Promise<CompletionSyncReply>((resolve) => {
        finish = () => resolve(reply(request, applyCompletionUpdates(new Map(), request.updates)!));
      }),
  );
  const session = new CompletionSession(sync),
    main = model();
  session.configure(workspace());
  session.bind("main.bp", main.value);
  await vi.advanceTimersByTimeAsync(50);
  main.append('Import "new"\n');
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.symbols("main.bp", position)).toBeUndefined();
  session.dispose();
});

it("retains known variables immediately and sends edits without reading the full buffer", async () => {
  vi.useFakeTimers();
  let documents = new Map<string, CompletionDocument>();
  const sync = vi.fn(async (_workspace: string, request: CompletionSyncRequest) => {
    documents = applyCompletionUpdates(
      request.baseRevision === null ? new Map() : documents,
      request.updates,
    )!;
    return reply(request, documents);
  });
  const session = new CompletionSession(sync),
    main = model();
  session.configure(workspace());
  session.bind("main.bp", main.value);
  await vi.advanceTimersByTimeAsync(50);
  vi.mocked(main.value.getValue).mockClear();
  main.append("k");
  expect(session.symbols("main.bp", position)?.map((s) => s.name)).toEqual(["known"]);
  await vi.advanceTimersByTimeAsync(50);
  expect(main.value.getValue).not.toHaveBeenCalled();
  expect(sync.mock.calls[1]![1].updates).toEqual([
    {
      kind: "edit",
      file: "main.bp",
      before: 1,
      version: 2,
      changes: [{ offset: 10, length: 0, text: "k" }],
    },
  ]);
  expect(documents.get("main.bp")?.text).toBe("known = 1\nk");
  session.dispose();
});

it("does not starve continuous typing or overlap requests and safely rebases a pending result", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  let documents = new Map<string, CompletionDocument>();
  const sync = vi.fn((_workspace: string, request: CompletionSyncRequest) => {
    const docs = (documents = applyCompletionUpdates(documents, request.updates)!);
    return new Promise<CompletionSyncReply>((resolve) => {
      finish = () => resolve(reply(request, docs));
    });
  });
  const session = new CompletionSession(sync),
    main = model();
  session.configure(workspace());
  session.bind("main.bp", main.value);
  for (let i = 0; i < 10; i++) {
    main.append("x");
    await vi.advanceTimersByTimeAsync(20);
  }
  expect(sync).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.symbols("main.bp", position)?.[0]?.name).toBe("known");
  await vi.advanceTimersByTimeAsync(150);
  expect(sync).toHaveBeenCalledTimes(2);
  session.dispose();
  finish();
  await vi.advanceTimersByTimeAsync(0);
});

it("resynchronizes after worker restart, and ignores results from another workspace", async () => {
  vi.useFakeTimers();
  const sync = vi.fn(
    async (_workspace: string, request: CompletionSyncRequest): Promise<CompletionSyncReply> => {
      if (sync.mock.calls.length === 1) return { kind: "resync" };
      return reply(request, applyCompletionUpdates(new Map(), request.updates)!);
    },
  );
  const session = new CompletionSession(sync),
    main = model();
  session.configure(workspace());
  session.bind("main.bp", main.value);
  await vi.advanceTimersByTimeAsync(50);
  expect(sync).toHaveBeenCalledTimes(2);
  expect(sync.mock.calls[1]![1].baseRevision).toBeNull();
  session.configure(workspace("other"));
  expect(session.symbols("main.bp", position)).toBeUndefined();
  session.dispose();
});
