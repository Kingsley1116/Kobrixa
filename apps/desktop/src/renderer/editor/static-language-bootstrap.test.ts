import { afterEach, expect, it, vi } from "vitest";
import type { StaticLanguageStore, StaticLanguageStoreSnapshot } from "./static-language-store.js";
import type { StaticLanguageRegistrar } from "./static-language-registration.js";
import { bootstrapStaticLanguages } from "./static-language-bootstrap.js";
import { createStaticLanguageStore } from "./static-language-store.js";
import { createStaticLanguageRegistrar } from "./static-language-registration.js";
import { initializeEditorThemes } from "./editor-theme.js";
import { windowStaticLanguages } from "./static-language-bootstrap.js";

vi.mock("monaco-editor", () => ({ editor: {} }));
vi.mock("./editor-theme.js", () => ({ initializeEditorThemes: vi.fn() }));
vi.mock("./static-language-store.js", () => ({ createStaticLanguageStore: vi.fn() }));
vi.mock("./static-language-registration.js", () => ({ createStaticLanguageRegistrar: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ports() {
  const pending = deferred();
  let snapshot: StaticLanguageStoreSnapshot = {
    phase: "loading",
    targetRevision: 7,
    owners: [],
    catalog: {
      formatVersion: 1,
      limitsVersion: 1,
      revision: 6,
      languages: [],
      extensionRoutes: {},
      conflicts: [],
    },
  };
  const store: StaticLanguageStore = {
    getSnapshot: () => snapshot,
    ready: () => pending.promise,
    subscribe: () => () => {},
    refresh: async () => {},
    dispose: vi.fn(),
  };
  const registrar: StaticLanguageRegistrar = {
    reconcile: vi.fn(),
    trackModel: () => ({ dispose() {} }),
    refreshModels: vi.fn(),
    resolve: () => ({
      kind: "plaintext",
      monacoLanguage: "plaintext",
      displayName: "Plain Text",
      catalogRevision: 7,
    }),
    getRoute: () => undefined,
    getActiveOwners: () => [],
    subscribe: () => () => {},
    dispose: vi.fn(),
  };
  return {
    store,
    registrar,
    pending,
    set: (next: StaticLanguageStoreSnapshot) => {
      snapshot = next;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("does not release document restoration before a consistent catalog is installed", async () => {
  const p = ports();
  const restore = vi.fn();
  const result = bootstrapStaticLanguages(p).then((value) => {
    restore();
    return value;
  });
  await Promise.resolve();
  expect(restore).not.toHaveBeenCalled();
  const snapshot = {
    ...p.store.getSnapshot(),
    phase: "ready" as const,
    catalog: { ...p.store.getSnapshot().catalog, revision: 7 },
  };
  p.set(snapshot);
  p.pending.resolve();
  expect(await result).toEqual({ kind: "ready", revision: 7 });
  expect(p.registrar.reconcile).toHaveBeenCalledWith(snapshot);
  expect(restore).toHaveBeenCalledOnce();
});

it("releases empty plugin routes at 5000 ms without treating the timer as a regex interrupter", async () => {
  vi.useFakeTimers();
  const p = ports();
  const settled = vi.fn();
  const promise = bootstrapStaticLanguages({ ...p, timeoutMs: 60000 }).then(settled);
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await promise;
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "plaintext", reason: "timeout" }),
  );
  expect(p.registrar.reconcile).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: "failed",
      targetRevision: 7,
      owners: [],
      catalog: expect.objectContaining({ revision: 7, languages: [], extensionRoutes: {} }),
    }),
  );
  expect(p.store.dispose).not.toHaveBeenCalled();
  expect(p.registrar.dispose).not.toHaveBeenCalled();
  p.pending.reject(new Error("late IPC failure"));
  await Promise.resolve();
});

it.each(["reject", "failed", "inconsistent"] as const)(
  "fails open for editing after %s IPC",
  async (mode) => {
    const p = ports();
    const result = bootstrapStaticLanguages(p);
    if (mode === "reject") p.pending.reject(new Error("IPC disconnected"));
    else {
      p.set({
        ...p.store.getSnapshot(),
        phase: mode === "failed" ? "failed" : "ready",
        error: "Catalog unavailable",
      });
      p.pending.resolve();
    }
    expect(await result).toMatchObject({ kind: "plaintext", reason: "ipc" });
    expect(p.registrar.reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ owners: [] }));
  },
);

it.each([
  "reconcile",
  "getSnapshot",
  "notified getSnapshot",
  "fallback reconcile",
  "subscriber",
] as const)(
  "settles the window barrier and releases later open/save operations when %s throws",
  async (failure) => {
    const p = ports();
    const snapshot = p.store.getSnapshot();
    const readySnapshot = {
      ...snapshot,
      phase: "ready" as const,
      catalog: { ...snapshot.catalog, revision: 7 },
    };
    p.set(readySnapshot);
    const error = new Error(`${failure} failed`);
    if (failure === "getSnapshot" || failure === "notified getSnapshot") {
      p.store.getSnapshot = vi.fn(() => {
        throw error;
      });
      if (failure === "notified getSnapshot") {
        vi.mocked(p.store.getSnapshot).mockReturnValueOnce(readySnapshot);
        let changed!: () => void;
        p.registrar.subscribe = (listener) => {
          changed = listener;
          return vi.fn();
        };
        vi.mocked(p.registrar.reconcile).mockImplementation(() => changed());
      }
    } else if (failure !== "subscriber") {
      vi.mocked(p.registrar.reconcile).mockImplementation(() => {
        throw error;
      });
    }
    vi.mocked(createStaticLanguageStore).mockReturnValue(p.store);
    vi.mocked(createStaticLanguageRegistrar).mockReturnValue(p.registrar);
    let unload!: () => void;
    vi.stubGlobal("window", {
      kobrixa: { plugins: {} },
      addEventListener: (_event: string, listener: () => void) => {
        unload = listener;
      },
    });
    try {
      const runtime = windowStaticLanguages();
      const updates: unknown[] = [];
      runtime.subscribe(() => updates.push(runtime.getSnapshot()));
      if (failure === "subscriber") {
        runtime.subscribe(() => {
          throw error;
        });
      }
      const opened = vi.fn();
      const saved = vi.fn();
      async function openFile() {
        await runtime.ready;
        opened();
      }
      async function saveTab() {
        await runtime.ready;
        saved();
      }
      const opening = openFile();
      // Attach a rejection handler before settling IPC so a failed assertion stays local.
      const openingResult = Promise.allSettled([opening]);
      expect(runtime.getSnapshot().settled).toBe(false);
      expect(opened).not.toHaveBeenCalled();
      if (failure === "fallback reconcile") p.pending.reject(new Error("IPC disconnected"));
      else p.pending.resolve();

      await expect(runtime.ready).resolves.toMatchObject({ kind: "plaintext", reason: "ipc" });
      expect(runtime.getSnapshot()).toMatchObject({
        settled: true,
        result: { kind: "plaintext", reason: "ipc", message: error.message },
      });
      expect(updates).toContainEqual(runtime.getSnapshot()); // Existing failure banner state.
      if (failure !== "subscriber") {
        expect(p.registrar.reconcile).toHaveBeenLastCalledWith(
          expect.objectContaining({
            phase: "failed",
            owners: [],
            catalog: expect.objectContaining({ languages: [], extensionRoutes: {} }),
          }),
        );
      }
      expect(await openingResult).toEqual([{ status: "fulfilled", value: undefined }]);
      await expect(openFile()).resolves.toBeUndefined();
      await expect(saveTab()).resolves.toBeUndefined();
      expect(opened).toHaveBeenCalledTimes(2);
      expect(saved).toHaveBeenCalledOnce();
    } finally {
      unload();
      vi.unstubAllGlobals();
    }
  },
);

it("reuses the window owner across effect replay and accepts later recovery", async () => {
  const p = ports();
  let unload!: () => void;
  let changed!: () => void;
  p.registrar.subscribe = (listener) => {
    changed = listener;
    return vi.fn();
  };
  vi.mocked(createStaticLanguageStore).mockReturnValue(p.store);
  vi.mocked(createStaticLanguageRegistrar).mockReturnValue(p.registrar);
  vi.stubGlobal("window", {
    kobrixa: { plugins: {} },
    addEventListener: (_event: string, listener: () => void) => {
      unload = listener;
    },
  });
  try {
    const first = windowStaticLanguages();
    const callback = vi.fn();
    first.subscribe(callback)(); // React cleanup only releases this listener.
    const second = windowStaticLanguages();
    const off = second.subscribe(callback);
    expect(second).toBe(first);
    expect(initializeEditorThemes).toHaveBeenCalledOnce();
    expect(createStaticLanguageRegistrar).toHaveBeenCalledOnce();
    p.pending.reject(new Error("disconnected"));
    expect(await second.ready).toMatchObject({ kind: "plaintext" });
    p.set({
      ...p.store.getSnapshot(),
      phase: "ready",
      targetRevision: 8,
      catalog: { ...p.store.getSnapshot().catalog, revision: 8 },
    });
    changed();
    expect(second.getSnapshot()).toMatchObject({
      settled: true,
      result: { kind: "ready", revision: 8 },
    });
    expect(p.registrar.dispose).not.toHaveBeenCalled();
    off();
  } finally {
    unload();
    vi.unstubAllGlobals();
  }
  expect(p.registrar.dispose).toHaveBeenCalledOnce();
  expect(p.store.dispose).toHaveBeenCalledOnce();
});
