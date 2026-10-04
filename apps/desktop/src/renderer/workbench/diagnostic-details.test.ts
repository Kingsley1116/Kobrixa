// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { languages } from "monaco-editor";
import type { Diagnostic } from "../../shared/api.js";
import type { AnalysisSession } from "../editor/analysis-session.js";
import { DiagnosticDetails, type DiagnosticDetailsHost } from "./diagnostic-details.js";

const diagnostic: Diagnostic = {
  code: "BP1043",
  severity: "error",
  file: "main.bp",
  range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 12 },
  message: "Expected ')' after arguments.",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function setup() {
  const listeners = new Set<() => void>();
  let snapshot = { analysis: { diagnostics: [diagnostic] } } as ReturnType<
    AnalysisSession["getCurrent"]
  >;
  const host: DiagnosticDetailsHost = {
    locale: "en",
    analysisSession: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getCurrent: () => snapshot,
    } as unknown as AnalysisSession,
    getQuickFixes: vi.fn(async () => [{ title: "Insert closing parenthesis )" }]),
    applyQuickFix: vi.fn(async () => {}),
    openDocumentation: vi.fn(async () => {}),
  };
  return {
    host,
    render: (item = diagnostic) =>
      act(async () => root.render(createElement(DiagnosticDetails, { ...host, diagnostic: item }))),
    invalidate: () =>
      act(() => {
        snapshot = undefined;
        listeners.forEach((listener) => listener());
      }),
  };
}

it("keeps the original diagnostic while changing explanations, action titles and documentation locale", async () => {
  const { host, render } = setup();
  await render();
  expect(container.textContent).toContain("Call is missing a closing parenthesis");
  expect(container.querySelector(".diagnostic-original pre")?.textContent).toBe(diagnostic.message);
  await act(async () =>
    container.querySelector<HTMLButtonElement>(".diagnostic-fixes button")!.click(),
  );
  expect(host.applyQuickFix).toHaveBeenCalledOnce();
  host.locale = "zh-TW";
  vi.mocked(host.getQuickFixes).mockResolvedValue([{ title: "補上右括號 )" }]);
  await render();
  expect(container.textContent).toContain("呼叫缺少右括號");
  expect(container.querySelector(".diagnostic-fixes button")?.textContent).toBe("補上右括號 )");
  expect(container.querySelector(".diagnostic-original pre")?.textContent).toBe(diagnostic.message);
  await act(() => container.querySelector<HTMLButtonElement>(".diagnostic-links button")!.click());
  expect(host.openDocumentation).toHaveBeenCalledWith({ code: "BP1043", locale: "zh-TW" });
});

it("discards a late fix when its analysis is invalidated and leaves historical guidance readable", async () => {
  const { host, render, invalidate } = setup();
  let finish!: (actions: languages.CodeAction[]) => void;
  vi.mocked(host.getQuickFixes).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  expect(container.querySelector("[role=status]")).not.toBeNull();
  const signal = vi.mocked(host.getQuickFixes).mock.calls[0]![1]!;
  expect(signal.aborted).toBe(false);
  await invalidate();
  expect(signal.aborted).toBe(true);
  await act(() => finish([{ title: "Old correction" }]));
  expect(container.querySelector(".diagnostic-fixes button")).toBeNull();
  expect(container.textContent).toContain(diagnostic.message);
  expect(container.querySelector(".diagnostic-links button")).not.toBeNull();
});

it("shows unknown diagnostics and preserves raw text without offering an unauthored link", async () => {
  const { host, render } = setup();
  const unknown = { ...diagnostic, code: "BP9999", message: "<unknown condition>" };
  await render(unknown);
  expect(container.textContent).toContain("Check the original message and source location.");
  expect(container.querySelector(".diagnostic-original pre")?.textContent).toBe(unknown.message);
  expect(container.querySelector(".diagnostic-links")).toBeNull();
  expect(host.getQuickFixes).not.toHaveBeenCalled();
});
