import type {
  BusinessResult,
  PersistenceFailureDetail,
  SettingsMutation,
  SettingsSnapshot,
  SettingsScalar,
  SettingKey,
  PluginErrorCodeV170,
} from "@kobrixa/plugin-protocol";
import type { SettingsDraftState } from "../plugin-ui/host-ports.js";
export type SettingsStoreTransport = {
  validate(key: SettingKey, value: SettingsScalar): boolean;
  read(): Promise<SettingsSnapshot>;
  mutate(input: {
    key: SettingKey;
    value: SettingsScalar;
    reset: boolean;
    schemaVersion: number;
    expectedRevision: string | null;
  }): Promise<BusinessResult<SettingsMutation, PersistenceFailureDetail, PluginErrorCodeV170>>;
};
export function createContributedSettingsStore(
  initial: SettingsSnapshot,
  io: SettingsStoreTransport,
) {
  let baseline = structuredClone(initial);
  const draft = new Map(initial.values.map((x) => [x.key, x.value]));
  const dirty = new Set<string>();
  const queued = new Map<string, { value: SettingsScalar; reset: boolean }>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  let busy: string | null = null,
    paused = false,
    disposed = false;
  let reconciling = false;
  let deferredWatch: SettingsSnapshot | undefined;
  let running: Promise<void> = Promise.resolve();
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const error = (key: string, message: string) => {
    errors.set(key, message);
    notify();
  };
  function snapshot(): SettingsDraftState {
    return {
      baseline: structuredClone(baseline),
      draft: [...draft].map(([key, value]) => ({ key, value })),
      busyKeys: busy ? [busy] : [],
      errors: [...errors].map(([key, en]) => ({ key, message: { en } })),
    };
  }
  function external(next: SettingsSnapshot) {
    if (disposed || next.schemaVersion !== baseline.schemaVersion) return;
    if (busy !== null) {
      deferredWatch = structuredClone(next);
      return;
    }
    if (next.revision === baseline.revision) return;
    baseline = structuredClone(next);
    for (const { key, value } of next.values) {
      if (!dirty.has(key)) draft.set(key, value);
      else errors.set(key, "Saved values changed. Reload or explicitly retry this field.");
    }
    if (dirty.size) {
      paused = true;
      queued.clear();
    }
    notify();
  }
  async function pump() {
    while (!disposed && !paused && queued.size) {
      const [key, item] = queued.entries().next().value!;
      queued.delete(key);
      busy = key;
      notify();
      const revisionAtDispatch = baseline.revision;
      try {
        const result = await io.mutate({
          key,
          ...item,
          schemaVersion: baseline.schemaVersion,
          expectedRevision: revisionAtDispatch,
        });
        if (disposed) return;
        if (!result.ok) {
          paused = true;
          error(key, result.error.message);
          if (
            result.error.detail?.kind === "persistence" &&
            result.error.detail.disposition === "unknown"
          )
            deferredWatch = await io.read();
          continue;
        }
        if (
          baseline.revision !== revisionAtDispatch &&
          baseline.revision !== result.value.receipt.revision
        ) {
          paused = true;
          error(key, "Saved values changed. Explicit retry required.");
          continue;
        }
        baseline = structuredClone(result.value.snapshot);
        if (draft.get(key) === item.value && !queued.has(key)) {
          dirty.delete(key);
          errors.delete(key);
        }
        for (const entry of baseline.values)
          if (!dirty.has(entry.key)) draft.set(entry.key, entry.value);
      } catch {
        paused = true;
        error(key, "Save outcome is unavailable. Read current values before retry.");
        try {
          deferredWatch = await io.read();
        } catch {
          error(key, "Current saved values are unavailable.");
        }
      } finally {
        busy = null;
        const observed = deferredWatch;
        deferredWatch = undefined;
        if (observed) external(observed);
        notify();
      }
    }
  }
  function edit(
    key: string,
    value: SettingsScalar,
    phase: "change" | "blur" | "enter" | "reset",
    immediate: boolean,
  ) {
    if (disposed || !draft.has(key)) return;
    draft.set(key, value);
    dirty.add(key);
    if (
      !io.validate(key, value) ||
      new TextEncoder().encode(JSON.stringify([...draft].map(([k, v]) => ({ key: k, value: v }))))
        .length > 65536
    ) {
      queued.delete(key);
      error(key, "Invalid value.");
      return;
    }
    errors.delete(key);
    const old = baseline.values.find((x) => x.key === key)?.value;
    if (old === value && !busy && !queued.has(key) && phase !== "reset") {
      dirty.delete(key);
      notify();
      return;
    }
    if (phase !== "change" || immediate) queued.set(key, { value, reset: phase === "reset" });
    notify();
    if (busy === null) running = pump();
  }
  return {
    state: snapshot,
    edit,
    external,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    idle: () => running,
    fail(message: string) {
      paused = true;
      for (const key of dirty) errors.set(key, message);
      notify();
    },
    async retry(key: string) {
      if (disposed || reconciling || !dirty.has(key)) return;
      reconciling = true;
      paused = true;
      queued.clear();
      try {
        await running;
        if (disposed || !dirty.has(key)) return;
        try {
          external(await io.read());
        } catch {
          error(key, "Current saved values are unavailable.");
          return;
        }
        if (disposed) return;
        const value = draft.get(key)!;
        if (!io.validate(key, value)) return;
        queued.clear();
        queued.set(key, { value, reset: false });
        paused = false;
        running = pump();
        await running;
      } finally {
        reconciling = false;
      }
    },
    async reload() {
      if (disposed || reconciling) return;
      reconciling = true;
      paused = true;
      queued.clear();
      try {
        await running;
        if (disposed) return;
        const value = await io.read();
        if (disposed) return;
        dirty.clear();
        queued.clear();
        errors.clear();
        paused = false;
        baseline = structuredClone(value);
        draft.clear();
        for (const entry of value.values) draft.set(entry.key, entry.value);
        notify();
      } finally {
        reconciling = false;
      }
    },
    dispose() {
      disposed = true;
      queued.clear();
      listeners.clear();
    },
  };
}
