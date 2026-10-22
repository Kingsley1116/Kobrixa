import { createRoot } from "react-dom/client";
import { PluginToolsPane } from "../../apps/desktop/src/renderer/plugin-ui/panel-host.js";
import { PluginStatusHost } from "../../apps/desktop/src/renderer/plugin-ui/status-host.js";
import {
  pluginUiWindow,
  settingsStore,
} from "../../apps/desktop/src/renderer/settings/settings-state.js";
import { diagnosticsFor as hostDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import { diagnosticsFor as stateDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/state-store.js";
import type { FoundationDiagnostics } from "@kobrixa/plugin-runtime";
import type { UiLabels } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import "../../apps/desktop/src/renderer/styles/index.css";

const check = (value: unknown, label: string): void => {
  if (!value) throw new Error(label);
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const wall = () => performance.timeOrigin + performance.now();
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
const root = createRoot(document.getElementById("root")!);
root.render(
  <>
    <PluginStatusHost session={owner.session} locale="en" labels={labels} />
    <PluginToolsPane session={owner.session} locale="en" labels={labels} onClose={() => {}} />
  </>,
);
const records = new Map<object, FoundationDiagnostics>();
const offs: Array<() => void> = [];
const recordOffs = new Map<object, () => void>();
const observations: unknown[] = [];
const inputPaints: Array<{ inputAt: number; paintedAt: number; trusted: boolean; value: string }> =
  [];
let recording = false;
const hides: Array<{ at: number; panelInstance: string; trusted: boolean }> = [];
function retain(instance: object, lookup: (value: object) => FoundationDiagnostics) {
  if (!records.has(instance)) records.set(instance, lookup(instance));
}
retain(owner.host, hostDiagnostics);
retain(owner.session.catalog, stateDiagnostics);
function discover() {
  for (const entry of owner.session.catalog.getSnapshot().entries) {
    const record = owner.session.record(entry);
    if (!record || records.has(record.state)) continue;
    retain(record.state, stateDiagnostics);
    recordOffs.set(
      record.state,
      stateDiagnostics(record.state).onEvent((event) => {
        if (recording)
          observations.push({ ...event, revision: record.state.getSnapshot().snapshot.revision });
      }),
    );
  }
}
offs.push(owner.session.subscribe(discover), owner.session.catalog.subscribe(discover));
function sample() {
  discover();
  return [...records.values()].map((diagnostics, id) => ({ id, counters: diagnostics.snapshot() }));
}
document.addEventListener(
  "input",
  (event) => {
    if (!recording || !(event.target instanceof HTMLInputElement)) return;
    const inputAt = wall(),
      element = event.target,
      value = element.value;
    // Two animation callbacks conservatively include a complete paint opportunity.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        inputPaints.push({
          inputAt,
          paintedAt: wall(),
          trusted: event.isTrusted,
          value,
        }),
      ),
    );
  },
  true,
);
function entries() {
  return owner.session.catalog.getSnapshot().entries;
}
document.addEventListener(
  "click",
  (event) => {
    if (
      !recording ||
      !(event.target instanceof Element) ||
      !event.target.closest(".plugin-tools-pane > header button")
    )
      return;
    const selected = entries().find((entry) => owner.session.selectedKey()?.includes(entry.id));
    const binding = selected && owner.session.record(selected)?.state.form().binding;
    if (binding)
      hides.push({ at: wall(), panelInstance: binding.panelInstance, trusted: event.isTrusted });
  },
  true,
);
async function openAll() {
  await owner.ready;
  const panels = entries().filter(
    (entry) => entry.kind === "panel" && entry.availability === "available",
  );
  check(panels.length === 16, `expected16 panels, got${panels.length}`);
  for (const panel of panels) {
    await owner.session.open(panel);
    await frame();
  }
  owner.session.select(panels[0]!);
  await frame();
  await frame();
  discover();
  check(
    entries().filter((entry) => entry.kind === "status" && owner.session.record(entry)).length ===
      16,
    "16 live statuses",
  );
  check(
    panels.every((entry) => owner.session.record(entry)),
    "16 live panels",
  );
  document
    .querySelector<HTMLDetailsElement>(".plugin-status-host details")
    ?.setAttribute("open", "");
  return { entries: entries(), diagnostics: sample() };
}
function bounds(kind: "input" | "hold" | "hide") {
  const element =
    kind === "hide"
      ? document.querySelector<HTMLButtonElement>(".plugin-tools-pane > header button")
      : kind === "input"
        ? [...document.querySelectorAll<HTMLInputElement>('input[type="text"]')][0]
        : [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent?.trim() === "Hold",
          );
  check(element && !element.disabled, `missing ${kind}`);
  element!.scrollIntoView({ block: "center" });
  const r = element!.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}
async function cycles(count: number) {
  const panels = entries().filter((entry) => entry.kind === "panel");
  for (const panel of panels) owner.session.close(panel);
  await frame();
  await frame();
  for (let i = 0; i < count; i++) {
    const entry = panels[i % panels.length]!;
    await owner.session.open(entry);
    await frame();
    check(document.querySelector(".plugin-tools-pane .plugin-ui"), `cycle${i} missing actual tree`);
    document.querySelector<HTMLButtonElement>("[data-close-contribution]")!.click();
    await frame();
    check(!owner.session.record(entry), `cycle${i} retained record`);
  }
  return sample();
}
Object.assign(window, {
  uiLoad: {
    ready: owner.ready,
    count: () => entries().length,
    openAll,
    bounds,
    cycles,
    sample,
    start() {
      observations.length = 0;
      inputPaints.length = 0;
      hides.length = 0;
      recording = true;
      return wall();
    },
    stop() {
      recording = false;
      return { at: wall(), observations, inputPaints, hides };
    },
    clear() {
      observations.length = 0;
      inputPaints.length = 0;
      hides.length = 0;
    },
    pruneRetired() {
      check(entries().length === 0, "pruning requires an actually empty catalog");
      const result = sample();
      for (const off of recordOffs.values()) off();
      recordOffs.clear();
      records.clear();
      retain(owner.host, hostDiagnostics);
      retain(owner.session.catalog, stateDiagnostics);
      return result;
    },
    show() {
      owner.session.showPane(true, "tab");
    },
    async dispose() {
      root.unmount();
      owner.dispose();
      await frame();
      await frame();
      const result = sample();
      for (const off of offs.splice(0)) off();
      for (const off of recordOffs.values()) off();
      recordOffs.clear();
      records.clear();
      return result;
    },
  },
});
