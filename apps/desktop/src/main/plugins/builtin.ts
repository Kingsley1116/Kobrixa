import { resolveBuiltinLaunch, validateBuiltinLeaf } from "./builtin-launch.js";
import type { PluginSource, PluginManager } from "@kobrixa/plugin-runtime";
import type { BuiltinDeviceProvider, ProviderCatalogPort } from "../device-broker/provider.js";
import type {
  DeviceBrokerPort,
  ProviderRegistration,
  ProviderRetirement,
} from "../device-broker/broker-port.js";
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
  const sources: PluginSource[] = [...BUILTIN_PLUGIN_SOURCES];
  for (const feature of [
    { slug: "motor-test", en: "Motor test", zh: "馬達測試" },
    { slug: "sensor-lab", en: "Sensor Lab", zh: "感測器實驗室" },
  ]) {
    const pluginId = `kobrixa.${feature.slug}`;
    try {
      const launch = await resolveBuiltinLaunch({
        ...input,
        slug: feature.slug,
        pluginId,
        sourceKey: `builtin:${pluginId}`,
      });
      const { manifest, resources } = await validateBuiltinLeaf(launch.packageRoot, pluginId);
      sources.push({ kind: "builtin", policy: "optional", manifest, resources, launch });
    } catch {
      // Host-only pre-read failure; no error text or physical paths cross this boundary.
      sources.push({
        kind: "builtin",
        policy: "optional",
        payloadUnavailable: true,
        resources: {},
        manifest: {
          id: pluginId,
          displayName: {
            en: `${feature.en} — shipped payload unavailable or invalid`,
            "zh-TW": `${feature.zh} — 隨附套件遺失或無效`,
          },
        },
      });
    }
  }
  return sources;
}

export const BUILTIN_DEVICE_PROVIDER_FACTORIES: Readonly<
  Record<"builtin:kobrixa.device-ev3", (catalog: ProviderCatalogPort) => BuiltinDeviceProvider>
> = Object.freeze({ "builtin:kobrixa.device-ev3": createEv3Provider });

/** Callable for existing disposers; hosts must await detach/settled to observe
 * provider cleanup. Manager action completion alone does not join this bridge. */
export type BuiltinProviderAttachment = (() => Promise<void>) & {
  settled(): Promise<void>;
  retry(): Promise<void>;
};

/** The caller owns the broker catalog allocator and the single profile lifetime. */
export function attachBuiltinDeviceProvider(
  manager: Pick<PluginManager, "onEvent" | "builtinSourceEligibility">,
  broker: DeviceBrokerPort,
  catalog: ProviderCatalogPort,
  factory: (
    catalog: ProviderCatalogPort,
  ) => BuiltinDeviceProvider = BUILTIN_DEVICE_PROVIDER_FACTORIES["builtin:kobrixa.device-ev3"],
): BuiltinProviderAttachment {
  if (!manager.builtinSourceEligibility)
    throw new Error("Builtin provider requires host source eligibility");
  const eligibility = manager.builtinSourceEligibility.bind(manager);
  let current:
    | {
        registration: ProviderRegistration;
        retirement: ProviderRetirement;
        generation: number;
        retiring: boolean;
      }
    | undefined;
  let initialCatalog: ProviderCatalogPort | undefined = catalog;
  let detached = false;
  let pending: Promise<void> | undefined;
  let failure: unknown;
  let failed = false;
  let reconciling = false;
  let dirty = false;
  const source = () =>
    eligibility().find(
      (row) =>
        row.sourceKey === "builtin:kobrixa.device-ev3" && row.pluginId === "kobrixa.device-ev3",
    );
  const reconcile = () => {
    const desired = source();
    const enabled =
      !detached && desired?.eligible && desired.providerIds.includes("kobrixa.device-ev3");
    current?.retirement.admission(
      !!enabled &&
        !pending &&
        !failed &&
        !current.retiring &&
        current.generation === desired?.generation,
    );
    // Retain the provider for the manager's original cleanup obligations. Neither
    // process exit nor a later desired generation can release this hold.
    if (desired?.cleanupPending) return;
    if (pending || failed) return;
    if (current && (current.retiring || !enabled || current.generation !== desired?.generation)) {
      const original = current;
      original.retiring = true;
      const attempt = original.retirement.retire(); // fences synchronously
      const work = attempt.then(
        () => {
          if (current === original) current = undefined;
          if (pending === work) pending = undefined;
          failed = false;
          observe(); // read latest desired state, never a captured enable/generation
        },
        (error: unknown) => {
          if (pending === work) pending = undefined;
          failure = error;
          failed = true;
        },
      );
      pending = work;
      return;
    }
    if (enabled && !current) {
      const currentCatalog = initialCatalog ?? broker.providerCatalog("kobrixa.device-ev3");
      // Keep an unregistered allocator through a factory failure so explicit
      // retry can reuse it; never ask the broker for a second live allocator.
      initialCatalog = currentCatalog;
      const provider = factory(currentCatalog);
      if (provider.id !== "kobrixa.device-ev3")
        throw new Error("EV3 allowlist factory returned the wrong provider");
      const registration = broker.registerProvider(provider);
      if (!registration.retirement) {
        registration();
        throw new Error("Builtin provider requires awaitable host retirement");
      }
      current = {
        registration,
        retirement: registration.retirement,
        generation: desired.generation,
        retiring: false,
      };
      initialCatalog = undefined;
      failed = false;
      // Registration publication can have synchronously changed desired state.
      dirty = true;
    }
    if (detached && !current) off();
  };
  const sync = () => {
    if (reconciling) {
      dirty = true;
      return;
    }
    reconciling = true;
    try {
      do {
        dirty = false;
        reconcile();
      } while (dirty);
    } finally {
      reconciling = false;
    }
  };
  const observe = () => {
    try {
      sync();
    } catch (error) {
      failure = error;
      failed = true;
    }
  };
  const off = manager.onEvent((event) => {
    if (event.type === "state") observe();
  });
  const settled = async () => {
    while (pending) await pending;
    if (failed) throw failure;
    if (source()?.cleanupPending)
      throw new Error("Provider settlement is held by manager cleanup; retry after it settles.");
  };
  try {
    sync();
  } catch (error) {
    detached = true;
    off();
    // Preserve synchronous initialization errors, but fence/observe any provider
    // already published by a reentrant factory or registration callback.
    if (current) void current.retirement.retire().catch(() => undefined);
    throw error;
  }
  const detach = () => {
    detached = true;
    observe();
    const work = settled();
    void work.catch(() => undefined); // legacy callers may still ignore detach
    return work;
  };
  return Object.assign(detach, {
    settled,
    retry: () => {
      failed = false;
      observe();
      return settled();
    },
  });
}
