export * from "./errors.js";
export * from "./diagnostic-help.js";
export * from "./compiler-resolution.js";
export * from "./registry.js";
export * from "./process.js";
export { PluginSupervisor, persistenceChannelApiVersion } from "./supervisor.js";
export type {
  LaunchablePlugin,
  PluginLauncher,
  SupervisorState,
  StopReason,
  SupervisorOptions,
} from "./supervisor.js";
export { PluginManager, PLUGIN_SHUTDOWN_DEADLINE_MS, PLUGIN_FORCE_MARGIN_MS } from "./manager.js";
export type {
  PluginPersistedState,
  PluginStateStore,
  PluginManagerOptions,
  PluginSummary,
  PluginsSnapshot,
  DiagnosticHelpCatalog,
  PluginNotice,
  PluginManagerEvent,
  PluginCommandResult,
  PluginActionResult,
} from "./manager.js";
export * from "./static-languages.js";

export type * from "./persistence-participant.js";
export type {
  SettingsFormBinding,
  SettingsFormPort,
  BoundSettingsService,
  ContributedSettingsForm,
  SettingsFieldMap,
} from "./settings-form-port.js";
export type * from "./device-resources.js";
export type * from "./profile-writer-lock.js";
export type * from "./core-actions.js";
export type * from "./builtin-launch.js";
export type {
  Stage3RuntimePorts,
  Stage3HostAttachment,
  Stage3ChannelContext,
  Stage3ChannelBinding,
  UiRuntimeAttachment,
  OwnerRetirement,
  RetirementDisposition,
} from "./ui-lifecycle.js";
export type * from "./ui-subscriptions.js";
export type {
  PluginUiBridge,
  UiCatalogPort,
  UiBridgeEvent,
  FoundationDiagnostics,
  FoundationCounters,
  FoundationDiagnosticEvent,
} from "./ui-host-ports.js";

export {
  createUiLifetimePort,
  ChannelActivation,
  registerActivationDeadline,
  remainingActivationMs,
  retireStage3Owner,
  resourceFreePersistence150,
  unavailableUi150,
} from "./ui-lifecycle.js";

export { UiCatalog } from "./ui-catalog.js";
export type { UiCatalogDependencies } from "./ui-catalog.js";
export type { UiCatalogSource } from "./ui-host-ports.js";
export { UiStateRegistry, currentStatusBindings } from "./ui-state.js";
export { UiSubscriptions } from "./ui-subscriptions.js";
export { sameUiBinding, sameResourceOwner } from "./ui-host-ports.js";

export { readPackagedJson, readBuiltinJson, SourceReadBudget } from "./packaged-json-resource.js";
