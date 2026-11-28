import { createRoot } from "react-dom/client";
import { PluginToolsPane } from "../../apps/desktop/src/renderer/plugin-ui/panel-host.js";
import {
  pluginUiWindow,
  settingsStore,
} from "../../apps/desktop/src/renderer/settings/settings-state.js";
import type { UiLabels } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import "../../apps/desktop/src/renderer/styles/index.css";

// The AM-21 native shell mounts the production pane and its window singleton.
// Full-workbench/legacy-Lab behavior has a separate, unmodified-product receipt.
const labels: UiLabels = {
  tools: "Plugin tools",
  open: "Open",
  close: "Close",
  empty: "Empty",
  unavailable: "Unavailable",
  loading: "Loading",
  invalid: "Invalid",
  recovery: "Recovery",
  refresh: "Refresh",
  reset: "Reset",
  previous: "Previous",
  next: "Next",
  retry: "Retry",
  export: "Export",
  discard: "Discard",
  checkpoint: "Checkpoint",
  holdHint: "Hold",
  actions: {
    stop: "Stop",
    reconcile: "Reconcile",
    "clear-resolved": "Clear",
    "retry-save": "Retry save",
    manage: "Manage",
  },
};
settingsStore.set("rightPanel", "plugins");
const owner = pluginUiWindow();
createRoot(document.getElementById("root")!).render(
  <PluginToolsPane session={owner.session} locale="en" labels={labels} onClose={() => {}} />,
);
void owner.ready.then(() => {
  const panel = owner.session.catalog.getSnapshot().entries.find((entry) => entry.kind === "panel");
  if (!panel) throw new Error("No admitted motion panel.");
  owner.session.select(panel);
});
