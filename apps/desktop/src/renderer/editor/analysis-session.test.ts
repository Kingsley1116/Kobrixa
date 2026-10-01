import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptySymbolIndex, type BasicPlusProjectAnalysis } from "@kobrixa/basic-plus";
import type { WorkspaceSummary } from "../../shared/api.js";
import { AnalysisSession } from "./analysis-session.js";
import { Documents } from "./documents.js";

const result = (): BasicPlusProjectAnalysis => ({
  diagnostics: [],
  tokensByFile: {},
  index: emptySymbolIndex(),
});
function harness() {
  const documents = new Documents();
  documents.replace([{ file: "main.bp", content: "value = 1", saved: "value = 1" }]);
  const requests: Array<(value: BasicPlusProjectAnalysis) => void> = [];
  const callbacks = {
    analyze: vi.fn(
      (_workspaceId: string, _overlays: Record<string, string>) =>
        new Promise<BasicPlusProjectAnalysis>((resolve) => requests.push(resolve)),
    ),
    cancel: vi.fn(),
    diagnostics: vi.fn(),
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
  session.configure(workspace);
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
  session.configure({ ...workspace, id: "two" });
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
