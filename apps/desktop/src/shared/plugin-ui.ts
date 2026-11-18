/** Host-only forward declarations; no renderer RPC is published by this module. */
export type { CoreActionReference, CoreWindowScope } from "@kobrixa/plugin-runtime";

export type {
  PluginUiBridge,
  CoreRecoveryPort,
  UiBridgeEvent,
  CoreRecoveryItem,
  CoreRecoverySnapshot,
} from "@kobrixa/plugin-runtime";
export type {
  UiOwner,
  UiCatalogEntry,
  UiCatalogPage,
  UiBinding,
  UiStateSnapshot,
  CommandInvocation,
  CommandValue,
} from "@kobrixa/plugin-protocol";
