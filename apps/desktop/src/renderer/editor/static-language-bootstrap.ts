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

function emptySnapshot(store: StaticLanguageStore, message: string): StaticLanguageStoreSnapshot {
  const revision = store.getSnapshot().targetRevision;
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
  const snapshot = store.getSnapshot();
  if (
    outcome === "ready" &&
    snapshot.phase === "ready" &&
    snapshot.catalog.revision >= snapshot.targetRevision
  ) {
    registrar.reconcile(snapshot);
    return { kind: "ready", revision: snapshot.catalog.revision };
  }
  const reason = outcome === "timeout" ? "timeout" : "ipc";
  const message =
    reason === "timeout"
      ? "Static language loading exceeded 5000 ms."
      : (snapshot.error ?? "Static language catalog is unavailable.");
  registrar.reconcile(emptySnapshot(store, message));
  return { kind: "plaintext", reason, message };
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
    coreExtensionRoutes: { json: "json" },
  });
  const listeners = new Set<() => void>();
  let snapshot: WindowStaticLanguageSnapshot = { settled: false, revision: 0 };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const off = registrar.subscribe(() => {
    const state = store.getSnapshot();
    const recovered =
      snapshot.settled && state.phase === "ready" && state.catalog.revision >= state.targetRevision;
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      ...(recovered
        ? { result: { kind: "ready" as const, revision: state.catalog.revision } }
        : {}),
    };
    notify();
  });
  const ready = bootstrapStaticLanguages({ store, registrar }).then((result) => {
    snapshot = { settled: true, result, revision: snapshot.revision + 1 };
    notify();
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
