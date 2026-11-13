import { createRoot } from "react-dom/client";
import { PluginToolsPane } from "../../apps/desktop/src/renderer/plugin-ui/panel-host.js";
import { PluginStatusHost } from "../../apps/desktop/src/renderer/plugin-ui/status-host.js";
import {
  createPluginUiWindow,
  settingsStore,
} from "../../apps/desktop/src/renderer/settings/settings-state.js";
import { diagnosticsFor as hostDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import { diagnosticsFor as stateDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/state-store.js";
import type { FoundationDiagnostics } from "@kobrixa/plugin-runtime";
import type { UiLabels } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import "../../apps/desktop/src/renderer/styles/index.css";
import { assertLoadCatalog, waitForLoad } from "./declarative-ui-load-fixture.js";

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
// This standalone foundation UI-load fixture has no device-migration host.
// Use the actual UI/recovery bridges without the optional migration adapter.
const windowOwner = createPluginUiWindow({
  bridge: window.kobrixa.plugins.ui,
  recovery: window.kobrixa.plugins.recovery,
  settings: settingsStore,
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  },
});
const environment = (reason: "document" | "window") =>
  windowOwner.session.environment(!document.hidden, document.hasFocus(), reason);
const visibility = () => environment("document");
const focus = () => environment("window");
let disposed = false;
const disposeWindow = () => {
  if (disposed) return;
  disposed = true;
  windowOwner.dispose();
  document.removeEventListener("visibilitychange", visibility);
  window.removeEventListener("focus", focus);
  window.removeEventListener("blur", focus);
  window.removeEventListener("pagehide", disposeWindow);
};
const owner = { ...windowOwner, dispose: disposeWindow };
document.addEventListener("visibilitychange", visibility);
window.addEventListener("focus", focus);
window.addEventListener("blur", focus);
window.addEventListener("pagehide", disposeWindow, { once: true });
environment("document");
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
function inspect() {
  return {
    focused: document.hasFocus(),
    hidden: document.hidden,
    phase: owner.session.catalog.getSnapshot().phase,
    selected: owner.session.selectedKey(),
    entries: entries().map((entry) => ({
      id: entry.id,
      sourceKey: entry.sourceKey,
      kind: entry.kind,
      availability: entry.availability,
      failed: owner.session.failed(entry),
      binding: owner.session.record(entry)?.state.form().binding ?? null,
      active: owner.session.record(entry)?.state.getSnapshot().active ?? false,
    })),
  };
}
const focused = () =>
  waitForLoad(
    () => ({ focused: document.hasFocus(), hidden: document.hidden }),
    (state) => state.focused && !state.hidden,
    "focused, visible load renderer",
  );
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
  assertLoadCatalog(entries());
  await focused();
  const panels = entries().filter(
    (entry) => entry.kind === "panel" && entry.availability === "available",
  );
  check(panels.length === 16, `expected16 panels, got${panels.length}`);
  for (const panel of panels) {
    await openPanel(panel);
    await frame();
  }
  owner.session.select(panels[0]!);
  await frame();
  await frame();
  discover();
  // Main initialization creates statuses, but renderer resource/snapshot adoption
  // is asynchronous and is not joined by panel open or two animation frames.
  await waitForLoad(
    inspect,
    (state) =>
      state.entries.filter((entry) => entry.kind === "status" && entry.active).length === 16,
    "16 live acceptance statuses",
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
async function openPanel(panel: ReturnType<typeof entries>[number]) {
  await waitForLoad(
    async () => {
      await focused();
      await owner.session.open(panel);
      check(!owner.session.failed(panel), `panel failed: ${JSON.stringify(inspect())}`);
      // A real blur while resource/open IPC is pending cancels the open. Retry
      // only until an actual record exists, after native focus has returned.
      return { opened: !!owner.session.record(panel), ...inspect() };
    },
    (state) => state.opened,
    `panel ${panel.id}`,
  );
}
async function bounds(kind: "input" | "hold" | "hide" | "number") {
  await focused();
  const find = () =>
    kind === "hide"
      ? document.querySelector<HTMLButtonElement>(".plugin-tools-pane > header button")
      : kind === "number"
        ? document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
        : kind === "input"
          ? [...document.querySelectorAll<HTMLInputElement>('input[type="text"]')][0]
          : [...document.querySelectorAll<HTMLButtonElement>("button")].find(
              (button) => button.textContent?.trim() === "Hold",
            );
  await waitForLoad(
    () => ({
      present: !!find(),
      enabled: find()?.disabled === false,
      focused: document.hasFocus(),
      hidden: document.hidden,
    }),
    (state) => state.focused && !state.hidden && state.enabled,
    `enabled native ${kind} control`,
  );
  const element = find();
  check(element && !element.disabled, `missing ${kind}: ${JSON.stringify(inspect())}`);
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
    await openPanel(entry);
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
    ready: owner.ready.then(() => true),
    inspect,
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
      return null;
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
      return null;
    },
    slowState() {
      const selected = entries().find((entry) => owner.session.selectedKey()?.includes(entry.id));
      const state = selected && owner.session.record(selected)?.state.getSnapshot();
      const field = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
      return {
        raw: field?.value ?? null,
        focused: field === document.activeElement,
        panelInstance: state?.snapshot.binding.panelInstance ?? null,
        revision: state?.snapshot.revision ?? null,
        active: state?.active ?? false,
      };
    },
    closeSelected() {
      document.querySelector<HTMLButtonElement>("[data-close-contribution]")!.click();
      return null;
    },
    hasInstance(id: string) {
      return entries().some(
        (entry) => owner.session.record(entry)?.state.form().binding.panelInstance === id,
      );
    },
    async reopenFirst() {
      const entry = entries().find((entry) => entry.kind === "panel")!;
      await owner.session.open(entry);
      owner.session.select(entry);
      await frame();
      await frame();
      const snapshot = owner.session.record(entry)!.state.getSnapshot().snapshot;
      return { panelInstance: snapshot.binding.panelInstance, revision: snapshot.revision };
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
