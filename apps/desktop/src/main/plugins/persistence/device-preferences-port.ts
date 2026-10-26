import type { SettingsSnapshot, SettingsField, SettingsResourceV1 } from "@kobrixa/plugin-protocol";
import { validateSettingsResource } from "../../../../../../packages/plugin-protocol/src/persistence-validation.js";
import {
  settingsValidationText,
  validateSettingsValues,
} from "../../../../../../packages/plugin-protocol/src/settings.js";
import {
  DEFAULT_DEVICE_PREFERENCES,
  USB_RETRY_INTERVALS,
  USB_RETRY_LIMITS,
  WIFI_CONNECT_TIMEOUTS,
  WIFI_HANDSHAKE_TIMEOUTS,
  type DevicePreferences,
} from "../../../shared/device-preferences.js";
import type { PersistenceBackend } from "./engine-port.js";
import { settingsRequests } from "./settings-service.js";

export const DEVICE_PREFERENCES_SOURCE = "builtin:kobrixa.device-ev3";
// Host policy contract, not a load of the optional shipped resource. The actual
// resource is resolved only AFTER namespace admission, and must match this shape.
function choice(
  key: string,
  value: string | number,
  options: readonly (string | number)[],
): SettingsField {
  return {
    key,
    label: { en: key },
    type: "enum",
    default: value,
    options: options.map((value) => ({ value, label: { en: String(value) } })),
  };
}
const expected: SettingsResourceV1 = {
  schemaVersion: 1,
  title: { en: "Device preferences" },
  fields: [
    {
      key: "skipUnchangedAssets",
      label: { en: "Skip unchanged assets" },
      type: "boolean",
      default: DEFAULT_DEVICE_PREFERENCES.skipUnchangedAssets,
    },
    {
      key: "usbAutoReconnect",
      label: { en: "USB auto reconnect" },
      type: "boolean",
      default: DEFAULT_DEVICE_PREFERENCES.usbAutoReconnect,
    },
    choice("usbRetryInterval", DEFAULT_DEVICE_PREFERENCES.usbRetryInterval, USB_RETRY_INTERVALS),
    choice("usbRetryLimit", DEFAULT_DEVICE_PREFERENCES.usbRetryLimit, USB_RETRY_LIMITS),
    choice(
      "wifiConnectTimeout",
      DEFAULT_DEVICE_PREFERENCES.wifiConnectTimeout,
      WIFI_CONNECT_TIMEOUTS,
    ),
    choice(
      "wifiHandshakeTimeout",
      DEFAULT_DEVICE_PREFERENCES.wifiHandshakeTimeout,
      WIFI_HANDSHAKE_TIMEOUTS,
    ),
    choice("connectionMode", "usb", ["usb", "wifi"]),
    {
      key: "rememberWifiAddress",
      label: { en: "Remember Wi-Fi address" },
      type: "boolean",
      default: false,
    },
    {
      key: "lastWifiAddress",
      resetWhen: { key: "rememberWifiAddress", equals: false },
      label: { en: "Last Wi-Fi address" },
      type: "string",
      default: "",
      minLength: 0,
      maxLength: 45,
      maxBytes: 180,
    },
  ],
};
export const devicePreferencesResource = validateSettingsResource(
  expected,
  Buffer.byteLength(JSON.stringify(expected)),
);
export type DevicePreferenceValues = DevicePreferences & {
  connectionMode: "usb" | "wifi";
  rememberWifiAddress: boolean;
  lastWifiAddress: string;
};
export function devicePreferenceValues(snapshot: SettingsSnapshot): DevicePreferenceValues {
  if (snapshot.schemaVersion !== 1) throw new Error("Unsupported device preferences schema.");
  const values = validateSettingsValues(devicePreferencesResource, snapshot.values, true);
  const result = Object.fromEntries(
    values.map(({ key, value }) => [key, value]),
  ) as unknown as DevicePreferenceValues;
  return result;
}
type HostSnapshot = Awaited<ReturnType<ReturnType<typeof settingsRequests>["hostSnapshot"]>>;
export type DevicePreferencesReady = HostSnapshot & {
  state: "ready";
  origin: "committed" | "validated-absent";
  values: DevicePreferenceValues;
};
export type DevicePreferencesState =
  | DevicePreferencesReady
  | {
      state: "unavailable";
      problem: string;
      lastCommitted: DevicePreferencesReady | null;
    };

/** Host-only committed policy reader. Callers must gate new optional I/O on state
 * ready, never on lastCommitted. No plugin principal, window, or ledger slot. */
export function createDevicePreferencesPort(input: {
  backend: PersistenceBackend;
  importReady(): boolean;
}) {
  const service = settingsRequests(input.backend);
  let disposed = false,
    retired = false,
    version = 0;
  let lastCommitted: DevicePreferencesReady | null = null;
  let state: DevicePreferencesState = {
    state: "unavailable",
    problem: "Not read.",
    lastCommitted: null,
  };
  const listeners = new Set<(state: DevicePreferencesState) => void>();
  let running: Promise<DevicePreferencesState> | undefined;
  let dirty = false;
  function publish(next: DevicePreferencesState) {
    state = structuredClone(next);
    for (const listener of [...listeners]) {
      try {
        listener(structuredClone(state));
      } catch {
        /* Observer isolation. */
      }
    }
  }
  function unavailable(problem: string): DevicePreferencesState {
    return { state: "unavailable", problem, lastCommitted: structuredClone(lastCommitted) };
  }
  function read(): Promise<DevicePreferencesState> {
    if (disposed || retired)
      return Promise.resolve(unavailable(disposed ? "Disposed." : "Settings source retired."));
    dirty = true;
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        while (dirty && !disposed) {
          dirty = false;
          const attempt = version;
          let next: DevicePreferencesState;
          try {
            const value = await service.hostSnapshot(DEVICE_PREFERENCES_SOURCE, input.importReady);
            if (!service.hostCurrent(value.namespace, input.importReady))
              throw new Error("Stale settings namespace.");
            if (
              settingsValidationText(value.resource) !==
              settingsValidationText(devicePreferencesResource)
            )
              throw new Error("Device preferences resource changed.");
            next = {
              ...value,
              state: "ready",
              origin: value.snapshot.revision === null ? "validated-absent" : "committed",
              values: devicePreferenceValues(value.snapshot),
            };
          } catch (error) {
            next = unavailable(error instanceof Error ? error.message : "Settings read failed.");
          }
          if (disposed || attempt !== version) continue;
          if (next.state === "ready" && next.origin === "committed")
            lastCommitted = structuredClone(next);
          publish(next);
        }
        return structuredClone(state);
      })
      .finally(() => {
        running = undefined;
        if (dirty && !disposed && !retired) void read();
      });
    return running;
  }
  // Register synchronously BEFORE the first read; commits during an awaited read
  // invalidate that result and cause one coalesced refresh, never a stale publish.
  const off = service.onCommitted({ sourceKey: DEVICE_PREFERENCES_SOURCE }, (reason) => {
    version++;
    if (reason === "retired") {
      retired = true;
      dirty = false;
      publish(unavailable("Settings source retired."));
    } else void read();
  });
  return {
    read,
    getSnapshot: () => {
      if (state.state === "ready" && !service.hostCurrent(state.namespace, input.importReady))
        return unavailable("Stale settings namespace.");
      return structuredClone(state);
    },
    watch(listener: (state: DevicePreferencesState) => void) {
      if (disposed) throw new Error("Disposed.");
      if (listeners.size >= 32) throw new Error("Device preference observer limit.");
      listeners.add(listener);
      // No gap between subscription and the requested authoritative read.
      void read();
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state = unavailable("Disposed.");
      version++;
      dirty = false;
      off();
      listeners.clear();
    },
  };
}
