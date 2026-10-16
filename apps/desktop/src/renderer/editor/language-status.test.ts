// @vitest-environment jsdom
import {
  act,
  createElement,
  StrictMode,
  useMemo,
  useLayoutEffect,
  useEffect,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createLanguageStatusStore } from "./language-status-store.js";
import type { LanguageStatus, LanguageStatusEvent } from "../../shared/language-services.js";
import { LanguageStatusRow } from "./language-status.js";
it.each(["en", "zh-TW"] as const)("shows the reason and settings action in %s", async (locale) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const openSettings = vi.fn();
  try {
    await act(() =>
      root.render(
        createElement(LanguageStatusRow, {
          locale,
          openSettings,
          status: {
            epoch: 1,
            conflicts: [],
            availability: { kind: "unavailable", reason: "missing", language: "case" },
          },
        }),
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("case");
    expect(container.textContent).toContain(
      locale === "en" ? "Open plugin settings" : "前往插件設定",
    );
    await act(() => container.querySelector("button")!.click());
    expect(openSettings).toHaveBeenCalledOnce();
    await act(() =>
      root.render(
        createElement(LanguageStatusRow, {
          locale,
          openSettings,
          status: {
            epoch: 2,
            conflicts: ["test.one", "test.two"],
            availability: { kind: "unavailable", reason: "conflict", language: "case" },
          },
        }),
      ),
    );
    expect(container.querySelector('[data-workspace-banner="true"]')).not.toBeNull();
    expect(container.textContent).toContain("test.one");
    expect(container.textContent).toContain("test.two");
    // An available provider with an empty diagnostics result is not unavailable.
    await act(() =>
      root.render(
        createElement(LanguageStatusRow, {
          locale,
          openSettings,
          status: {
            epoch: 3,
            conflicts: [],
            availability: {
              kind: "available",
              binding: {
                epoch: 3,
                pluginId: "test.one",
                sourceKey: "builtin:test.one",
                language: "case",
                extensions: ["csx"],
                capabilities: ["analysis"],
                frontend: {
                  language: "case",
                  sourceExtensions: ["csx"],
                  entryExtensions: ["csx"],
                  ir: { min: 1, max: 1 },
                },
              },
            },
          },
        }),
      ),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(() =>
      root.render(createElement(LanguageStatusRow, { locale, openSettings, status: undefined })),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});

it("keeps the App status subscription live through StrictMode effect replay", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = new Set<(event: LanguageStatusEvent) => void>();
  const initial: LanguageStatus = {
    epoch: 1,
    conflicts: [],
    availability: { kind: "unavailable", reason: "missing", language: "case" },
  };
  const api = {
    status: async () => initial,
    onStatus: (listener: (event: LanguageStatusEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function Harness() {
    const store = useMemo(() => createLanguageStatusStore(api), []);
    const status = useSyncExternalStore(store.subscribe, store.getSnapshot);
    useLayoutEffect(() => {
      store.configure("w");
    }, [store]);
    useEffect(() => () => store.dispose(), [store]);
    return createElement(LanguageStatusRow, { status, locale: "en", openSettings() {} });
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() => root.render(createElement(StrictMode, null, createElement(Harness))));
    expect(listeners.size).toBe(1);
    expect(container.textContent).toContain("No language service is available");
    await act(() => {
      for (const emit of listeners)
        emit({
          workspaceId: "w",
          status: {
            epoch: 2,
            conflicts: ["test.one", "test.two"],
            availability: { kind: "unavailable", reason: "conflict", language: "case" },
          },
        });
    });
    expect(container.querySelector('[data-workspace-banner="true"]')).not.toBeNull();
    expect(container.textContent).toContain("test.two");
  } finally {
    await act(() => root.unmount());
    expect(listeners.size).toBe(0);
    vi.unstubAllGlobals();
  }
});

it.each(["en", "zh-TW"] as const)(
  "shows project errors and the no-entry message in %s",
  async (locale) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      for (const hasDiagnostics of [true, false]) {
        await act(() =>
          root.render(
            createElement(LanguageStatusRow, {
              locale,
              openSettings: vi.fn(),
              status: {
                epoch: 1,
                conflicts: [],
                availability: {
                  kind: "unavailable",
                  reason: "project-error",
                  message: hasDiagnostics
                    ? "Invalid JSON"
                    : "Choose an entry file before checking.",
                  diagnostics: hasDiagnostics
                    ? [
                        {
                          code: "MAN1001",
                          source: "kobrixa.core",
                          severity: "error",
                          message: "Invalid JSON",
                          file: "kobrixa.json",
                          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
                        },
                      ]
                    : [],
                },
              },
            }),
          ),
        );
        expect(container.querySelector('[role="status"]')?.textContent).toBe(
          hasDiagnostics
            ? "Invalid JSON"
            : locale === "en"
              ? "Choose an entry file before checking."
              : "請先選擇進入點檔案，再進行檢查。",
        );
        expect(container.querySelector("button")).toBeNull();
      }
    } finally {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
