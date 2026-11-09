import { useEffect, useState, useSyncExternalStore } from "react";
import type { PluginsApi } from "../../shared/plugins.js";
import type { PluginHelpCatalogView } from "../../shared/diagnostic-help.js";

/** Keeps the newest plugin help catalog; an older response never replaces a newer one. */
export function createDiagnosticHelpStore(api: Pick<PluginsApi, "diagnosticHelp" | "onEvent">) {
  let current: PluginHelpCatalogView | undefined;
  let requested = -1;
  let disposed = false;
  const listeners = new Set<() => void>();
  const load = () => {
    void api.diagnosticHelp().then(
      (next) => {
        if (disposed || (current && next.revision <= current.revision)) return;
        current = next;
        for (const listener of listeners) listener();
      },
      () => {
        requested = current?.revision ?? -1;
      },
    );
  };
  const off = api.onEvent((event) => {
    if (disposed || event.type !== "state") return;
    const revision = event.state.diagnosticHelpRevision;
    if (revision <= requested || (current && revision <= current.revision)) return;
    requested = revision;
    load();
  });
  load();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => current,
    dispose() {
      disposed = true;
      off();
      listeners.clear();
    },
  };
}

const subscribeEmpty = () => () => {};
const getEmptySnapshot = () => undefined;

/** Own subscriptions in an effect so StrictMode replay cannot leak or dispose the active store. */
export function useDiagnosticHelpCatalog(api: Pick<PluginsApi, "diagnosticHelp" | "onEvent">) {
  const [store, setStore] = useState<ReturnType<typeof createDiagnosticHelpStore>>();
  useEffect(() => {
    const next = createDiagnosticHelpStore(api);
    setStore(next);
    return () => next.dispose();
  }, [api]);
  return useSyncExternalStore(
    store?.subscribe ?? subscribeEmpty,
    store?.getSnapshot ?? getEmptySnapshot,
  );
}
