import type { PluginsApi } from "../../shared/plugins.js";
import type { StaticLanguageOwner, StaticLanguagesCatalog } from "../../shared/static-languages.js";

export interface StaticLanguageStoreSnapshot {
  phase: "loading" | "ready" | "failed";
  /** Highest observed catalog target; distinct from accepted catalog.revision. */
  targetRevision: number;
  /** Complete owner metadata for targetRevision, including ambiguous extensions. */
  owners: readonly StaticLanguageOwner[];
  catalog: StaticLanguagesCatalog;
  error?: string;
}
export interface StaticLanguageStore {
  getSnapshot(): StaticLanguageStoreSnapshot;
  subscribe(listener: () => void): () => void;
  /** Settles when the first consistent catalog arrives or the initial fetch fails. */
  ready(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
}
export type StaticLanguageStoreApi = Pick<PluginsApi, "state" | "staticLanguages" | "onEvent">;

/** T0 empty snapshot; no subscription or IPC side effects. */
export function createStaticLanguageStore(api: StaticLanguageStoreApi): StaticLanguageStore {
  void api;
  const snapshot: StaticLanguageStoreSnapshot = {
    phase: "failed",
    targetRevision: 0,
    owners: [],
    catalog: {
      formatVersion: 1,
      limitsVersion: 1,
      revision: 0,
      languages: [],
      extensionRoutes: {},
      conflicts: [],
    },
    error: "not implemented",
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    dispose() {},
  };
}
