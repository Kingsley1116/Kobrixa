import type { DeviceConnectionPolicy } from "../../device-broker/provider.js";
import type { PersistenceBackend } from "./engine-port.js";
import type { HostSettingsNamespace } from "./host-port.js";
import type { DeviceSettingsMigrationGate } from "./device-settings-migration.js";
import {
  createDevicePreferencesPort,
  type DevicePreferencesReady,
  type DevicePreferencesState,
} from "./device-preferences-port.js";

/** Main-only lifecycle around the completed import and authoritative reader.
 * Construct after settings service attachment. No constructor I/O or plugin
 * activation; metadata eligibility is the only admission source. */
export function createDeviceSettingsHost(input: {
  backend: PersistenceBackend;
  namespace(): HostSettingsNamespace | null;
  migration: DeviceSettingsMigrationGate;
}) {
  let reader: ReturnType<typeof createDevicePreferencesPort> | undefined;
  let readerKey: string | undefined;
  let offReader: (() => void) | undefined;
  let disposed = false,
    version = 0,
    dirty = false;
  let running: Promise<DevicePreferencesState> | undefined;
  let lastCommitted: DevicePreferencesReady | null = null;
  let state: DevicePreferencesState = {
    state: "unavailable",
    problem: "Not read.",
    lastCommitted: null,
  };
  const listeners = new Set<(value: DevicePreferencesState) => void>();
  const unavailable = (problem: string): DevicePreferencesState => ({
    state: "unavailable",
    problem,
    lastCommitted: structuredClone(lastCommitted),
  });
  const namespace = () => {
    if (disposed) return null;
    try {
      return input.namespace();
    } catch {
      return null;
    }
  };
  function publish(value: DevicePreferencesState): void {
    if (value.state === "ready" && value.origin === "committed")
      lastCommitted = structuredClone(value);
    state = structuredClone(value);
    for (const listener of [...listeners]) {
      try {
        listener(structuredClone(state));
      } catch {
        /* Observer isolation. */
      }
    }
  }
  function discardReader(): void {
    offReader?.();
    offReader = undefined;
    reader?.dispose();
    reader = undefined;
    readerKey = undefined;
  }
  function getSnapshot(): DevicePreferencesState {
    if (disposed) return unavailable("Disposed.");
    const current = namespace();
    if (!current || JSON.stringify(current) !== readerKey || !input.migration.ready())
      return unavailable("Device settings are not admitted.");
    return reader?.getSnapshot() ?? structuredClone(state);
  }
  function refresh(): Promise<DevicePreferencesState> {
    if (disposed) return Promise.resolve(unavailable("Disposed."));
    dirty = true;
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        while (dirty && !disposed) {
          dirty = false;
          const current = namespace(),
            key = current ? JSON.stringify(current) : undefined,
            attempt = version;
          if (!current) {
            discardReader();
            publish(unavailable("Device settings source is unavailable."));
            continue;
          }
          try {
            await input.migration.prepare(new AbortController().signal);
            if (disposed || version !== attempt || JSON.stringify(namespace()) !== key) continue;
            if (readerKey !== key) {
              discardReader();
              const next = createDevicePreferencesPort({
                backend: input.backend,
                importReady: () => input.migration.ready(),
              });
              reader = next;
              readerKey = key;
              offReader = next.watch((value) => {
                if (!disposed && reader === next && JSON.stringify(namespace()) === key)
                  publish(value);
              });
            }
            const value = await reader!.read();
            if (!disposed && version === attempt && JSON.stringify(namespace()) === key)
              publish(value);
          } catch (error) {
            if (!disposed && version === attempt)
              publish(
                unavailable(
                  error instanceof Error ? error.message : "Device settings unavailable.",
                ),
              );
          }
        }
        return getSnapshot();
      })
      .finally(() => {
        running = undefined;
        if (dirty && !disposed) void refresh();
      });
    return running;
  }
  const offMigration = input.migration.watch(() => {
    void refresh();
  });
  function values() {
    const value = getSnapshot();
    if (value.state !== "ready") throw new Error(value.problem);
    return value.values;
  }
  return {
    migration: input.migration,
    refresh,
    getSnapshot,
    /** Source transaction calls this before asynchronous catalog refresh. */
    sourceChanged() {
      if (disposed) return;
      version++;
      discardReader();
      publish(unavailable("Device settings source changed."));
      void refresh();
    },
    connectionPolicy(): DeviceConnectionPolicy {
      const value = values();
      return {
        wifiConnectTimeoutMs: value.wifiConnectTimeout,
        wifiHandshakeTimeoutMs: value.wifiHandshakeTimeout,
        usbAutoReconnect: value.usbAutoReconnect,
        usbRetryInterval: value.usbRetryInterval,
        usbRetryLimit: value.usbRetryLimit,
      };
    },
    skipUnchangedAssets: () => values().skipUnchangedAssets,
    watch(listener: (value: DevicePreferencesState) => void) {
      if (disposed || listeners.size >= 32)
        throw new Error("Device settings observer unavailable.");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      version++;
      dirty = false;
      offMigration();
      discardReader();
      input.migration.dispose();
      listeners.clear();
      state = unavailable("Disposed.");
    },
  };
}
export type DeviceSettingsHost = ReturnType<typeof createDeviceSettingsHost>;
