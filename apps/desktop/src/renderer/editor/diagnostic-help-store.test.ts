// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createDiagnosticHelpStore, useDiagnosticHelpCatalog } from "./diagnostic-help-store.js";
import type { PluginHelpCatalogView } from "../../shared/diagnostic-help.js";

const view = (revision: number): PluginHelpCatalogView => ({ revision, plugins: {} });
function fakeApi() {
  let listener: ((event: unknown) => void) | undefined;
  const pending: Array<(value: PluginHelpCatalogView) => void> = [];
  const failures: Array<(reason: Error) => void> = [];
  return {
    api: {
      diagnosticHelp: vi.fn(
        () =>
          new Promise<PluginHelpCatalogView>((resolve, reject) => {
            pending.push(resolve);
            failures.push(reject);
          }),
      ),
      onEvent: (next: (event: unknown) => void) => {
        listener = next;
        return () => (listener = undefined);
      },
    },
    emitRevision: (revision: number) =>
      listener?.({ type: "state", state: { diagnosticHelpRevision: revision } }),
    reject: (index: number) => failures[index]!(new Error("Unavailable")),
    emitNotice: () => listener?.({ type: "notice", notice: {} }),
    resolve: (index: number, value: PluginHelpCatalogView) => pending[index]!(value),
  };
}

it("loads once and refetches only when the catalog revision changes", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  fake.resolve(0, view(1));
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(1);
  fake.emitRevision(1);
  expect(fake.api.diagnosticHelp).toHaveBeenCalledTimes(1);
  fake.emitRevision(2);
  expect(fake.api.diagnosticHelp).toHaveBeenCalledTimes(2);
});
it("ignores an older catalog that resolves after a newer one", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  fake.emitRevision(5);
  fake.resolve(1, view(5));
  await Promise.resolve();
  fake.resolve(0, view(4));
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(5);
});

it("coalesces repeated and older revision events while a load is pending", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  fake.resolve(0, view(1));
  await Promise.resolve();
  fake.emitRevision(3);
  fake.emitRevision(3);
  fake.emitRevision(2);
  fake.emitNotice();
  expect(fake.api.diagnosticHelp).toHaveBeenCalledTimes(2);
  fake.resolve(1, view(3));
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(3);
  store.dispose();
});

it("notifies subscribers only for newer catalogs and unsubscribes", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  const listener = vi.fn();
  const off = store.subscribe(listener);
  expect(store.getSnapshot()).toBeUndefined();
  fake.emitRevision(2);
  fake.resolve(1, view(2));
  await Promise.resolve();
  fake.resolve(0, view(2));
  await Promise.resolve();
  expect(listener).toHaveBeenCalledOnce();
  off();
  fake.emitRevision(3);
  fake.resolve(2, view(3));
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(3);
  expect(listener).toHaveBeenCalledOnce();
  store.dispose();
});

it("retains the last catalog on failure and loads the next revision", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  fake.resolve(0, view(1));
  await Promise.resolve();
  fake.emitRevision(2);
  fake.reject(1);
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(1);
  fake.emitRevision(2);
  expect(fake.api.diagnosticHelp).toHaveBeenCalledTimes(2);
  fake.emitRevision(3);
  fake.resolve(2, view(3));
  await Promise.resolve();
  expect(store.getSnapshot()?.revision).toBe(3);
  store.dispose();
});

it("stops listening and ignores pending responses after disposal", async () => {
  const fake = fakeApi();
  const store = createDiagnosticHelpStore(fake.api as never);
  const listener = vi.fn();
  store.subscribe(listener);
  store.dispose();
  fake.emitRevision(2);
  fake.resolve(0, view(1));
  await Promise.resolve();
  expect(fake.api.diagnosticHelp).toHaveBeenCalledOnce();
  expect(listener).not.toHaveBeenCalled();
  expect(store.getSnapshot()).toBeUndefined();
});

it("keeps a live catalog subscription through StrictMode replay and cleans up on unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = new Set<(event: unknown) => void>();
  let revision = 1;
  const api = {
    diagnosticHelp: vi.fn(async () => view(revision)),
    onEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function Harness() {
    const catalog = useDiagnosticHelpCatalog(api as never);
    return createElement("span", null, catalog?.revision);
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(Harness))));
    expect(container.textContent).toBe("1");
    expect(listeners.size).toBe(1);
    const initialCalls = api.diagnosticHelp.mock.calls.length;
    await act(async () => {
      for (const listener of listeners)
        listener({ type: "state", state: { diagnosticHelpRevision: 1 } });
    });
    expect(api.diagnosticHelp).toHaveBeenCalledTimes(initialCalls);
    revision = 2;
    await act(async () => {
      for (const listener of listeners)
        listener({ type: "state", state: { diagnosticHelpRevision: 2 } });
    });
    expect(container.textContent).toBe("2");
    expect(api.diagnosticHelp).toHaveBeenCalledTimes(initialCalls + 1);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(listeners.size).toBe(0);
});
