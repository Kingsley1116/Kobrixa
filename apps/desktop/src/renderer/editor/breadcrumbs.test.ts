// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { emptyAnalysis } from "../../shared/language-sync.js";
import type { LanguageFeatureReply } from "../../shared/language-query.js";
import type { EditorAnalysis } from "./editor.js";
import type { AnalysisSession } from "./analysis-session.js";
import { Breadcrumbs } from "./breadcrumbs.js";
import { CursorStore } from "./documents.js";

type Snapshot = NonNullable<ReturnType<AnalysisSession["getCurrent"]>>;
function snapshot(epoch: number): Snapshot {
  const analysis = emptyAnalysis();
  analysis.index.sources["main.bp"] = "Sub Work\nEndSub";
  return {
    workspaceId: "w",
    revision: 1,
    epoch,
    analysis,
    overlays: analysis.index.sources,
    binding: {
      epoch,
      pluginId: "kobrixa.basic-plus",
      sourceKey: "builtin:kobrixa.basic-plus",
      language: "bp",
      extensions: ["bp"],
      capabilities: ["analysis", "documentSymbols"],
      frontend: {
        language: "bp",
        entryExtensions: ["bp"],
        sourceExtensions: ["bp"],
        ir: { min: 1, max: 1 },
      },
    },
  };
}
const outline = (epoch: number): LanguageFeatureReply => ({
  kind: "result",
  epoch,
  result: {
    kind: "documentSymbols",
    symbols: [
      {
        name: "Work",
        detail: "Sub",
        kind: "function",
        range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 7 },
        selectionRange: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 9 },
        children: [],
      },
    ],
  },
});
it.each(["en", "zh-TW"] as const)(
  "queries outlines, keeps provider detail and rejects stale replies in %s",
  async (locale) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    let current: Snapshot | undefined = snapshot(1);
    let listener: Parameters<AnalysisSession["subscribe"]>[0] | undefined;
    const session = {
      getCurrent: () => current,
      subscribe: (next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as AnalysisSession;
    const pending: Array<(reply: LanguageFeatureReply) => void> = [];
    const query = vi.fn(
      (_snapshot: EditorAnalysis, _query: unknown, _signal: AbortSignal) =>
        new Promise<LanguageFeatureReply>((resolve) => pending.push(resolve)),
    );
    try {
      await act(() =>
        root.render(
          createElement(Breadcrumbs, {
            file: "main.bp",
            analysisSession: session,
            query,
            locale,
            cursor: new CursorStore(),
            onReveal: vi.fn(),
          }),
        ),
      );
      expect(query.mock.calls[0]![1]).toEqual({ kind: "documentSymbols", file: "main.bp" });
      await act(() => pending[0]!(outline(1)));
      await act(() => container.querySelector<HTMLButtonElement>(".breadcrumb-symbols")!.click());
      expect(container.querySelector("kbd")?.textContent).toBe("Sub");
      await act(() => {
        current = undefined;
        listener?.(undefined, "invalidate");
      });
      expect(container.querySelector("kbd")?.textContent).toBe("Sub");
      await act(() => {
        current = snapshot(1);
        listener?.(current, "result");
      });
      const signal = query.mock.calls[1]![2];
      await act(() => {
        current = undefined;
        listener?.(undefined, "reset");
      });
      expect(signal.aborted).toBe(true);
      expect(container.querySelector(".breadcrumb-symbols")).toBeNull();
      await act(() => {
        current = snapshot(3);
        listener?.(current, "result");
      });
      await act(() => pending[1]!(outline(1)));
      expect(container.querySelector(".breadcrumb-symbols")).toBeNull();
      await act(() => pending[2]!(outline(3)));
      expect(container.querySelector(".breadcrumb-symbols")).not.toBeNull();
    } finally {
      await act(() => root.unmount());
      expect(listener).toBeUndefined();
      vi.unstubAllGlobals();
    }
  },
);
