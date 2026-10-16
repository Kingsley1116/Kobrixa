import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyAnalysis } from "../../shared/language-sync.js";
import type { LanguageStatus } from "../../shared/language-services.js";
import type { AnalysisOutcome } from "./analysis-transport.js";
import type { WorkspaceSummary } from "../../shared/api.js";
import { AnalysisSession } from "./analysis-session.js";
import { createLanguageStatusStore } from "./language-status-store.js";
import type { LanguageStatusEvent } from "../../shared/language-services.js";
import { Documents } from "./documents.js";

const result = (epoch = 1): AnalysisOutcome => ({
  kind: "result",
  epoch,
  analysis: emptyAnalysis(),
});
function analysisStatus(epoch: number): LanguageStatus {
  return {
    epoch,
    conflicts: [],
    availability: {
      kind: "available",
      binding: {
        epoch,
        pluginId: "kobrixa.basic-plus",
        sourceKey: "builtin:kobrixa.basic-plus",
        language: "bp",
        extensions: ["bp", "bpi", "bpm"],
        capabilities: ["analysis"],
        frontend: {
          language: "bp",
          entryExtensions: ["bp"],
          sourceExtensions: ["bp", "bpi", "bpm"],
          ir: { min: 1, max: 1 },
        },
      },
    },
  };
}
function harness(initialized = true) {
  const documents = new Documents();
  documents.replace([{ file: "main.bp", content: "value = 1", saved: "value = 1" }]);
  const requests: Array<(value: AnalysisOutcome) => void> = [];
  const callbacks = {
    analyze: vi.fn(
      (_workspaceId: string, _overlays: Record<string, string>) =>
        new Promise<AnalysisOutcome>((resolve) => requests.push(resolve)),
    ),
    cancel: vi.fn(),
    diagnostics: vi.fn(),
    unavailable: vi.fn(),
    checking: vi.fn(),
    error: vi.fn(),
  };
  const session = new AnalysisSession(documents, callbacks);
  const events = vi.fn();
  session.subscribe(events);
  const workspace = {
    id: "one",
    files: ["main.bp"],
    drafts: { "helper.bpm": "Sub Help()\nEndSub", "kobrixa.json": "{}" },
  } as unknown as WorkspaceSummary;
  const detach = session.attach();
  if (initialized) session.configure(workspace, analysisStatus(1));
  callbacks.diagnostics.mockClear();
  return { documents, callbacks, requests, session, workspace, detach, events };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("collects the latest overlay lazily after 500 ms and invalidates feature queries immediately", async () => {
  const { documents, session, callbacks, requests, detach, events } = harness();
  let text = "value = 1",
    version = 1;
  const getValue = vi.fn(() => text);
  documents.bind("main.bp", {
    getValue,
    getValueLength: () => text.length,
    getVersionId: () => version,
    getAlternativeVersionId: () => version,
    setValue: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(500);
  requests[0]!(result());
  await vi.advanceTimersByTimeAsync(0);
  expect(session.getCurrent()).toBeDefined();
  getValue.mockClear();
  events.mockClear();
  for (let i = 0; i < 12; i++) {
    text += " ";
    version++;
    documents.changed("main.bp");
    expect(session.getCurrent()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(getValue).not.toHaveBeenCalled();
  expect(callbacks.analyze).toHaveBeenCalledTimes(1);
  expect(events).toHaveBeenCalledExactlyOnceWith(undefined, "invalidate");
  await vi.advanceTimersByTimeAsync(400);
  expect(callbacks.analyze).toHaveBeenLastCalledWith("one", {
    "main.bp": text,
    "helper.bpm": "Sub Help()\nEndSub",
  });
  expect(getValue).toHaveBeenCalledTimes(1);
  detach();
});

it("discards results from older document versions and workspaces, including effect reattachment", async () => {
  const { documents, session, callbacks, requests, workspace, detach } = harness();
  await vi.advanceTimersByTimeAsync(500);
  documents.replace([{ file: "main.bp", content: "new = 1", saved: "value = 1" }]);
  requests[0]!(result());
  await vi.advanceTimersByTimeAsync(500);
  expect(callbacks.diagnostics).not.toHaveBeenCalled();
  session.configure({ ...workspace, id: "two" }, analysisStatus(1));
  expect(callbacks.diagnostics).toHaveBeenCalledExactlyOnceWith(emptyAnalysis());
  callbacks.diagnostics.mockClear();
  requests[1]!(result());
  await vi.advanceTimersByTimeAsync(500);
  expect(callbacks.diagnostics).not.toHaveBeenCalled();
  detach();
  const detachAgain = session.attach();
  requests[2]!(result());
  await vi.advanceTimersByTimeAsync(500);
  expect(callbacks.diagnostics).not.toHaveBeenCalled();
  requests[3]!(result());
  await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.diagnostics).toHaveBeenCalledTimes(1);
  expect(session.getCurrent()?.workspaceId).toBe("two");
  detachAgain();
});

it("restarts analysis after availability recovers without a document edit", async () => {
  const { documents, session, callbacks, requests, workspace, detach } = harness();
  try {
    await vi.advanceTimersByTimeAsync(500);
    requests[0]!(result());
    await vi.advanceTimersByTimeAsync(0);
    const revision = documents.revision;
    session.configure(workspace, {
      epoch: 2,
      conflicts: [],
      availability: { kind: "unavailable", reason: "missing", language: "bp" },
    });
    expect(session.getCurrent()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callbacks.analyze).toHaveBeenCalledTimes(1);
    session.configure(workspace, analysisStatus(3));
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.analyze).toHaveBeenCalledTimes(2);
    expect(documents.revision).toBe(revision);
    requests[1]!(result(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getCurrent()?.epoch).toBe(3);
    expect(callbacks.diagnostics).toHaveBeenCalledTimes(4);
  } finally {
    detach();
  }
});

it("publishes unavailable separately from an empty successful analysis", async () => {
  const { session, callbacks, requests, detach } = harness();
  try {
    await vi.advanceTimersByTimeAsync(500);
    const unavailable = {
      kind: "unavailable",
      epoch: 1,
      reason: "missing",
      language: "bp",
    } as const;
    requests[0]!(unavailable);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.unavailable).toHaveBeenCalledExactlyOnceWith(unavailable);
    expect(callbacks.diagnostics).not.toHaveBeenCalled();
    expect(session.getCurrent()).toBeUndefined();
  } finally {
    detach();
  }
});

it.each([false, true])(
  "publishes project-error diagnostics once and clears on recovery (previous binding: %s)",
  async (initialized) => {
    const { session, callbacks, workspace, detach, requests } = harness(initialized);
    const diagnostics = [
      {
        code: "MAN1001",
        source: "kobrixa.core",
        severity: "error" as const,
        message: "Invalid JSON",
        file: "kobrixa.json",
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
      },
    ];
    const broken: LanguageStatus = {
      epoch: 2,
      conflicts: [],
      availability: {
        kind: "unavailable",
        reason: "project-error",
        message: "Invalid JSON",
        diagnostics,
      },
    };
    let emit!: (event: LanguageStatusEvent) => void;
    const report = vi.fn();
    const store = createLanguageStatusStore(
      {
        status: async () => broken,
        onStatus: (listener) => {
          emit = listener;
          return () => {};
        },
      },
      report,
    );
    const off = store.subscribe(() => session.configure(workspace, store.getSnapshot()));
    try {
      // If already bound, keep old analysis in flight during the status transition.
      await vi.advanceTimersByTimeAsync(500);
      store.configure(workspace.id);
      await Promise.resolve();
      expect(store.getSnapshot()).toEqual(broken);
      expect(report).not.toHaveBeenCalled();
      expect(callbacks.diagnostics).toHaveBeenLastCalledWith({ ...emptyAnalysis(), diagnostics });
      const calls = callbacks.diagnostics.mock.calls.length;
      session.configure({ ...workspace, files: [...workspace.files] }, broken);
      emit({ workspaceId: workspace.id, status: broken });
      requests[0]?.(result(1));
      await vi.advanceTimersByTimeAsync(1000);
      expect(callbacks.diagnostics).toHaveBeenCalledTimes(calls);
      expect(callbacks.analyze).toHaveBeenCalledTimes(initialized ? 1 : 0);
      expect(session.getCurrent()).toBeUndefined();
      emit({ workspaceId: workspace.id, status: analysisStatus(3) });
      expect(callbacks.diagnostics).toHaveBeenLastCalledWith(emptyAnalysis());
      emit({ workspaceId: workspace.id, status: broken });
      expect(callbacks.diagnostics).toHaveBeenCalledTimes(calls + 1);
      await vi.advanceTimersByTimeAsync(500);
      expect(callbacks.analyze).toHaveBeenCalledTimes(initialized ? 2 : 1);
    } finally {
      off();
      store.dispose();
      detach();
    }
  },
);
