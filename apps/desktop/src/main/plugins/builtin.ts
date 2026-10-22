import type { PluginSource, PluginManager } from "@kobrixa/plugin-runtime";
import type { BuiltinDeviceProvider, ProviderCatalogPort } from "../device-broker/provider.js";
import type { DeviceBrokerPort } from "../device-broker/broker-port.js";
import { createEv3Provider } from "../device-providers/ev3/provider.js";
import basicPlus from "../../../../../plugins/basic-plus/kobrixa-plugin.json" with { type: "json" };
import tokenizer from "../../../../../plugins/basic-plus/language/tokenizer.json?raw";
import configuration from "../../../../../plugins/basic-plus/language/configuration.json?raw";
import ev3 from "../../../../../plugins/ev3/kobrixa-plugin.json" with { type: "json" };

const capabilities = [
  "connection.v1",
  "telemetry.v1",
  "inputModes.v1",
  "finiteMotion.v1",
  "recordingReservation.v1",
] as const;
export const BUILTIN_PLUGIN_SOURCES: readonly PluginSource[] = [
  {
    kind: "builtin",
    policy: "required",
    manifest: basicPlus,
    resources: {
      "language/tokenizer.json": tokenizer,
      "language/configuration.json": configuration,
    },
  },
  { kind: "builtin", policy: "required", manifest: ev3, resources: {} },
  {
    kind: "builtin",
    policy: "optional",
    resources: {},
    manifest: {
      id: "kobrixa.device-ev3",
      version: "1.0.0",
      apiVersion: "^1.5.0",
      runtime: { kind: "builtin" },
      displayName: { en: "EV3 device provider", "zh-TW": "EV3 設備供應者" },
      contributes: {
        deviceProviders: [{ id: "kobrixa.device-ev3", capabilities: [...capabilities] }],
      },
    },
  },
];

export const BUILTIN_DEVICE_PROVIDER_FACTORIES: Readonly<
  Record<"builtin:kobrixa.device-ev3", (catalog: ProviderCatalogPort) => BuiltinDeviceProvider>
> = Object.freeze({ "builtin:kobrixa.device-ev3": createEv3Provider });

/** The caller owns the broker catalog allocator and the single profile lifetime. */
export function attachBuiltinDeviceProvider(
  manager: Pick<PluginManager, "state" | "onEvent">,
  broker: DeviceBrokerPort,
  catalog: ProviderCatalogPort,
  factory: (
    catalog: ProviderCatalogPort,
  ) => BuiltinDeviceProvider = BUILTIN_DEVICE_PROVIDER_FACTORIES["builtin:kobrixa.device-ev3"],
): () => void {
  let unregister: (() => void) | undefined;
  let initialCatalog: ProviderCatalogPort | undefined = catalog;
  const reconcile = () => {
    const enabled = manager
      .state()
      .plugins.some(
        (source) =>
          source.sourceKey === "builtin:kobrixa.device-ev3" &&
          source.status === "enabled" &&
          !source.required &&
          source.canToggle,
      );
    if (enabled && !unregister) {
      const currentCatalog = initialCatalog ?? broker.providerCatalog("kobrixa.device-ev3");
      initialCatalog = undefined;
      const provider = factory(currentCatalog);
      if (provider.id !== "kobrixa.device-ev3")
        throw new Error("EV3 allowlist factory returned the wrong provider");
      unregister = broker.registerProvider(provider);
    } else if (!enabled && unregister) {
      const remove = unregister;
      unregister = undefined;
      remove();
    }
  };
  const off = manager.onEvent((event) => {
    if (event.type === "state") reconcile();
  });
  try {
    reconcile();
  } catch (error) {
    off();
    throw error;
  }
  return () => {
    off();
    const remove = unregister;
    unregister = undefined;
    remove?.();
  };
}
