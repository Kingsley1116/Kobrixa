import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginStatusHost } from "../../apps/desktop/src/renderer/plugin-ui/status-host.js";
import { PluginToolsPane } from "../../apps/desktop/src/renderer/plugin-ui/panel-host.js";
import {
  pluginUiWindow,
  settingsStore,
  useSettings,
} from "../../apps/desktop/src/renderer/settings/settings-state.js";
import type { UiLabels } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import "../../apps/desktop/src/renderer/styles/index.css";

// Generic native lab shell. No feature callbacks or lab facade.
// Only generic settings/session controls; the launcher supplies the production preload/bridge.
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
// Stable DOM identity is observational only; the driver still sends native input.
const targetIds = new WeakMap<Element, number>();
let targetSequence = 0;
function nativeTargetId(element: Element) {
  let id = targetIds.get(element);
  if (!id) targetIds.set(element, (id = ++targetSequence));
  return id;
}
Object.assign(window, { labNativeTargetId: nativeTargetId });
// Observe trusted browser events without synthesizing events or invoking feature code.
for (const type of [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "click",
  "keydown",
  "keyup",
  "input",
]) {
  window.addEventListener(
    type,
    (event) => {
      const element = event.target instanceof Element ? event.target : null;
      const target = element?.closest("[data-ui-node]");
      const control = element?.closest("button, input, select, label");
      console.log(
        "NATIVE_INPUT:" +
          JSON.stringify({
            at: performance.timeOrigin + performance.now(),
            type: event.type,
            isTrusted: event.isTrusted,
            node: target?.getAttribute("data-ui-node"),
            close: !!element?.closest('[data-close-contribution="true"]'),
            status: !!element?.closest("#lab-status"),
            targetId: control ? nativeTargetId(control) : null,
            ariaLabel: control?.getAttribute("aria-label"),
            dialog: !!element?.closest('[role="dialog"]'),
            key: event instanceof KeyboardEvent ? event.key : null,
            repeat: event instanceof KeyboardEvent ? event.repeat : null,
          }),
      );
    },
    true,
  );
}
settingsStore.set("rightPanel", "plugins");
settingsStore.set("locale", "en");
const owner = pluginUiWindow();
// Observe the same panel record and control that PanelTree uses for dispatch.
Object.assign(window, {
  labRefreshTarget(x: number, y: number, targetId: number) {
    const panel = owner.session.catalog
      .getSnapshot()
      .entries.find((entry) => entry.kind === "panel" && entry.pluginId === "kobrixa.sensor-lab");
    const record = panel && owner.session.record(panel);
    const state = record?.state;
    const interaction = record?.interactions?.getSnapshot();
    const datasets = record?.datasets;
    const presentation = datasets?.getSnapshot().presentation;
    // Presentation zero precedes the first panel publication. Both libraries
    // must be readable in the scalar presentation that this click will use.
    const librariesPublished =
      presentation !== undefined &&
      presentation > 0 &&
      state?.getSnapshot().snapshot.data.presentation === presentation &&
      datasets?.revision("history") !== undefined &&
      datasets?.revision("profiles") !== undefined;
    const button = document.querySelector<HTMLButtonElement>(
      '[role="tabpanel"] [data-ui-node="refresh"] button',
    );
    const hit = document.elementFromPoint(x, y);
    const focused = document.hasFocus();
    return {
      ready: !!(
        focused &&
        button &&
        !button.disabled &&
        nativeTargetId(button) === targetId &&
        button.contains(hit) &&
        state?.actionEnabled("refresh") &&
        state.formCurrent() &&
        state.derivedCurrent() &&
        librariesPublished &&
        interaction?.view &&
        !interaction.busy
      ),
      enabled: state?.actionEnabled("refresh"),
      formCurrent: state?.formCurrent(),
      derivedCurrent: state?.derivedCurrent(),
      busy: interaction?.busy,
      focused,
      activeElement: document.activeElement?.tagName,
      hit: hit?.tagName,
      hitNode: hit?.closest("[data-ui-node]")?.getAttribute("data-ui-node"),
      targetId,
      x,
      y,
      binding: state?.form().binding,
      presentation,
      librariesPublished,
      viewGeneration: interaction?.view?.generation,
      problem: interaction?.problem ?? state?.getSnapshot().problem,
    };
  },
});
function Harness() {
  const { values } = useSettings();
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    document.documentElement.lang = values.locale;
  }, [values.locale]);
  return (
    <>
      <nav aria-label="Test shell">
        <button data-harness="show" onClick={() => settingsStore.set("rightPanel", "plugins")}>
          Show tools
        </button>
        <button
          data-harness="locale"
          onClick={() => settingsStore.set("locale", values.locale === "en" ? "zh-TW" : "en")}
        >
          Change locale
        </button>
        <button data-harness="layout" onClick={() => setNarrow((value) => !value)}>
          320 px / 125%
        </button>
      </nav>
      <main style={{ width: narrow ? 320 : 640, zoom: narrow ? 1.25 : 1 }}>
        {values.rightPanel === "plugins" && (
          <PluginToolsPane
            session={owner.session}
            locale={values.locale}
            labels={labels}
            onClose={() => settingsStore.set("rightPanel", null)}
          />
        )}
        <aside id="lab-status">
          <PluginStatusHost session={owner.session} locale={values.locale} labels={labels} />
        </aside>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
void owner.ready.then(() => {
  const panel = owner.session.catalog
    .getSnapshot()
    .entries.find((entry) => entry.kind === "panel" && entry.pluginId === "kobrixa.sensor-lab");
  if (!panel) return; // Safe mode intentionally has no optional panel.
  owner.session.select(panel);
});
