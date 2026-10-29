import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginToolsPane } from "../../apps/desktop/src/renderer/plugin-ui/panel-host.js";
import {
  pluginUiWindow,
  settingsStore,
  useSettings,
} from "../../apps/desktop/src/renderer/settings/settings-state.js";
import { mountContributedSettings170 } from "../../apps/desktop/src/renderer/settings/settings-panel.js";
import {
  SettingsControls,
  SettingsControlsView,
} from "../../apps/desktop/src/renderer/plugin-ui/forms.js";
import type { UiLabels } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import "../../apps/desktop/src/renderer/styles/index.css";
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

// Fixture legacy bytes are seeded by the initial HTML before this production capture adapter.
// These controls never invoke a feature controller or install settings/UI handlers.
const owner = pluginUiWindow();
settingsStore.set("rightPanel", "plugins");
settingsStore.set("locale", "en");
const query = new URLSearchParams(location.search);
const digest = query.get("digest")!;
// The generic form obtains the real committed document scope from settings.open.
// Never carry an about:blank scope into the renderer through a pre-navigation URL.
function DeviceSettings() {
  const [controls] = useState(() => new SettingsControls());
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () =>
      mountContributedSettings170({
        api: window.kobrixa.plugins.settings,
        sourceKey: "builtin:kobrixa.device-ev3",
        resourceDigest: digest,
        controls,
        failure: (value) => setError(String(value)),
      }),
    [controls],
  );
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <SettingsControlsView controls={controls} locale="en" labels={labels} />
    </>
  );
}
// Observation-only identity shared by the driver and actual trusted browser events.
const targetIds = new WeakMap<Element, number>();
let nextTarget = 0;
const deviceNativeTargetId = (element: Element) => {
  let id = targetIds.get(element);
  if (!id) {
    id = ++nextTarget;
    targetIds.set(element, id);
  }
  return id;
};
Object.assign(window, { deviceNativeTargetId });
for (const type of ["pointerdown", "pointerup", "input"])
  window.addEventListener(
    type,
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest("button,input,select");
      console.log(
        "NATIVE_INPUT:" +
          JSON.stringify({
            at: performance.timeOrigin + performance.now(),
            type,
            targetId: control ? deviceNativeTargetId(control) : null,
            ariaLabel: control?.getAttribute("aria-label") ?? null,
            isTrusted: event.isTrusted,
            node: target?.closest("[data-ui-node]")?.getAttribute("data-ui-node"),
            id: target?.id,
            text: target?.textContent?.slice(0, 100),
          }),
      );
    },
    true,
  );
function Harness() {
  const { values } = useSettings();
  const [settings, showSettings] = useState(false);
  return (
    <>
      <nav>
        <button data-harness="show" onClick={() => settingsStore.set("rightPanel", "plugins")}>
          Show tools
        </button>
        <button data-harness="settings" onClick={() => showSettings((value) => !value)}>
          Toggle settings
        </button>
      </nav>
      <main style={{ width: 800 }}>
        {values.rightPanel === "plugins" && (
          <PluginToolsPane
            session={owner.session}
            locale="en"
            labels={labels}
            onClose={() => settingsStore.set("rightPanel", null)}
          />
        )}
        {settings && <DeviceSettings />}
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
window.addEventListener("pagehide", () => owner.dispose(), { once: true });
