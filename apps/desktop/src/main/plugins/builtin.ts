import { resolveBuiltinLaunch, validateBuiltinLeaf } from "./builtin-launch.js";
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

/** Product-only assembly; explicit native fixtures keep using the static base list. */
export async function assembleBuiltinPluginSources(input: {
  packaged: boolean;
  appPath: string;
  buildRoot: string;
}): Promise<readonly PluginSource[]> {
  try {
    const launch = await resolveBuiltinLaunch({
      ...input,
      slug: "motor-test",
      pluginId: "kobrixa.motor-test",
      sourceKey: "builtin:kobrixa.motor-test",
    });
    const { manifest, resources } = await validateBuiltinLeaf(launch.packageRoot, launch.pluginId);
    return [
      ...BUILTIN_PLUGIN_SOURCES,
      { kind: "builtin", policy: "optional", manifest, resources, launch },
    ];
  } catch {
    // Host-only pre-read failure; no error text or physical paths cross this boundary.
    return [
      ...BUILTIN_PLUGIN_SOURCES,
      {
        kind: "builtin",
        policy: "optional",
        payloadUnavailable: true,
        resources: {},
        manifest: {
          id: "kobrixa.motor-test",
          displayName: {
            en: "Motor test — shipped payload unavailable or invalid",
            "zh-TW": "馬達測試 — 隨附套件遺失或無效",
          },
        },
      },
    ];
  }
}

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
