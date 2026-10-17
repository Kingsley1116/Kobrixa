import { CORE_EXTENSION_ROUTES } from "./core-language-routes.js";
import type { StaticLanguageRegistrar } from "./static-language-registration.js";
import type { StaticLanguageStore } from "./static-language-store.js";
import * as monaco from "monaco-editor";
import { useSyncExternalStore } from "react";
import { initializeEditorThemes } from "./editor-theme.js";
import {
  createStaticLanguageStore,
  type StaticLanguageStoreSnapshot,
} from "./static-language-store.js";
import { createStaticLanguageRegistrar } from "./static-language-registration.js";

export interface StaticLanguageBootstrapInput {
  store: StaticLanguageStore;
  registrar: StaticLanguageRegistrar;
  /** Defaults to 5,000; test clocks may shorten it, production cannot raise it. */
  timeoutMs?: number;
}
export type StaticLanguageBootstrapResult =
  | { kind: "ready"; revision: number }
  | { kind: "plaintext"; reason: "ipc" | "timeout"; message: string };

function bootstrapFailure(
  error?: unknown,
): Extract<StaticLanguageBootstrapResult, { kind: "plaintext" }> {
  return {
    kind: "plaintext",
    reason: "ipc",
    message: error instanceof Error ? error.message : "Static language catalog is unavailable.",
  };
}

function emptySnapshot(revision: number, message: string): StaticLanguageStoreSnapshot {
  return {
    phase: "failed",
    targetRevision: revision,
    owners: [],
    error: message,
    catalog: {
      formatVersion: 1,
      limitsVersion: 1,
      revision,
      languages: [],
      extensionRoutes: {},
      conflicts: [],
    },
  };
}

export async function bootstrapStaticLanguages({
  store,
  registrar,
  timeoutMs = 5000,
}: StaticLanguageBootstrapInput): Promise<StaticLanguageBootstrapResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = Math.min(5000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 5000));
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), wait);
  });
  const ipc = Promise.resolve()
    .then(() => store.ready())
    .then(
      () => "ready" as const,
      () => "ipc" as const,
    );
  const outcome = await Promise.race([ipc, timeout]);
  clearTimeout(timer);
  let snapshot: StaticLanguageStoreSnapshot | undefined;
  let fallback = bootstrapFailure();
  try {
    snapshot = store.getSnapshot();
    if (
      outcome === "ready" &&
      snapshot.phase === "ready" &&
      snapshot.catalog.revision >= snapshot.targetRevision
    ) {
      registrar.reconcile(snapshot);
      return { kind: "ready", revision: snapshot.catalog.revision };
    }
    fallback =
      outcome === "timeout"
        ? {
            kind: "plaintext",
            reason: "timeout",
            message: "Static language loading exceeded 5000 ms.",
          }
        : { ...fallback, message: snapshot.error ?? fallback.message };
  } catch (error) {
    fallback = bootstrapFailure(error);
  }
  try {
    // Reuse the last snapshot; reading the store again may repeat the original failure.
    registrar.reconcile(emptySnapshot(snapshot?.targetRevision ?? 0, fallback.message));
  } catch (error) {
    // Even failure to remove plugin routes must release the editing barrier.
    fallback = bootstrapFailure(error);
  }
  return fallback;
}

export interface WindowStaticLanguageSnapshot {
  settled: boolean;
  revision: number;
  result?: StaticLanguageBootstrapResult;
}
export interface WindowStaticLanguages {
  store: StaticLanguageStore;
  registrar: StaticLanguageRegistrar;
  ready: Promise<StaticLanguageBootstrapResult>;
  getSnapshot(): WindowStaticLanguageSnapshot;
  subscribe(listener: () => void): () => void;
}
let windowOwner: WindowStaticLanguages | undefined;

export function windowStaticLanguages(): WindowStaticLanguages {
  if (windowOwner) return windowOwner;
  initializeEditorThemes(monaco.editor);
  const store = createStaticLanguageStore(window.kobrixa.plugins);
  const registrar = createStaticLanguageRegistrar({
    monaco,
    store,
    api: window.kobrixa.plugins,
    coreExtensionRoutes: CORE_EXTENSION_ROUTES,
  });
  const listeners = new Set<() => void>();
  let snapshot: WindowStaticLanguageSnapshot = { settled: false, revision: 0 };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const off = registrar.subscribe(() => {
    try {
      const state = store.getSnapshot();
      const recovered =
        snapshot.settled &&
        state.phase === "ready" &&
        state.catalog.revision >= state.targetRevision;
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        ...(recovered
          ? { result: { kind: "ready" as const, revision: state.catalog.revision } }
          : {}),
      };
    } catch (error) {
      if (!snapshot.settled) throw error; // Let bootstrap install its plaintext fallback.
      snapshot = { ...snapshot, revision: snapshot.revision + 1, result: bootstrapFailure(error) };
    }
    notify();
  });
  const ready = bootstrapStaticLanguages({ store, registrar })
    .then((result) => {
      snapshot = { settled: true, result, revision: snapshot.revision + 1 };
      notify();
      return result;
    })
    .catch((error) => {
      const result = bootstrapFailure(error);
      snapshot = { settled: true, result, revision: snapshot.revision + 1 };
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A failing subscriber must not block editing or other failure-banner listeners.
        }
      }
      return result;
    });
  windowOwner = {
    store,
    registrar,
    ready,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  window.addEventListener(
    "pagehide",
    () => {
      off();
      registrar.dispose();
      store.dispose();
      listeners.clear();
      windowOwner = undefined;
    },
    { once: true },
  );
  return windowOwner;
}

export function useStaticLanguages() {
  const runtime = windowStaticLanguages();
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  return { runtime, snapshot };
}
