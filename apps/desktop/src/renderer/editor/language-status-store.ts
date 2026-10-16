import type { LanguageStatus, LanguageStatusEvent } from "../../shared/language-services.js";
interface StatusApi {
  status(workspaceId: string, refresh?: boolean): Promise<LanguageStatus>;
  onStatus(listener: (event: LanguageStatusEvent) => void): () => void;
}
export function createLanguageStatusStore(
  api: StatusApi,
  report: (error: unknown) => void = console.error,
) {
  let workspaceId: string | undefined;
  let current: LanguageStatus | undefined;
  let sequence = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const accept = (id: string, status: LanguageStatus) => {
    if (disposed || id !== workspaceId || (current && status.epoch <= current.epoch)) return;
    current = status;
    emit();
  };
  let off: (() => void) | undefined;
  return {
    configure(id: string | undefined) {
      // Subscribe in the layout effect, not the render-time store initializer.
      disposed = false;
      off ??= api.onStatus(({ workspaceId, status }) => accept(workspaceId, status));
      if (id === workspaceId) return;
      workspaceId = id;
      current = undefined;
      const request = ++sequence;
      emit();
      if (id)
        void api.status(id).then(
          (status) => {
            if (request === sequence) accept(id, status);
          },
          (error) => {
            if (!disposed && request === sequence) report(error);
          },
        );
    },
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      sequence++;
      off?.();
      off = undefined;
      workspaceId = undefined;
      current = undefined;
      listeners.clear();
    },
  };
}
