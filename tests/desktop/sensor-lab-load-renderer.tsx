import { canonicalDatasetV2Bytes } from "@kobrixa/plugin-protocol";
import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { createRoot } from "react-dom/client";
import { PluginStatusHost } from "../../apps/desktop/src/renderer/plugin-ui/status-host.js";
import { PluginToolsPane } from "../../apps/desktop/src/renderer/plugin-ui/panel-host.js";
import {
  createPluginUiWindow,
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
for (const type of ["pointerdown", "pointerup", "pointercancel", "keydown", "keyup", "input"]) {
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
const apply: number[] = [],
  input: number[] = [],
  cursor: number[] = [];
let recording = false;
const received = new Map<string, { at: number; revision: number }>();
const ui = window.kobrixa.plugins.ui;
const owner = createPluginUiWindow({
  bridge: {
    ...ui,
    async dataRead(params) {
      const result = await ui.dataRead(params);
      if (recording && result.ok && result.value.done)
        received.set(params.dataset, { at: performance.now(), revision: params.revision });
      return result;
    },
  },
  recovery: window.kobrixa.plugins.recovery,
  settings: settingsStore,
  storage: window.localStorage,
});
const environment = () =>
  owner.session.environment(!document.hidden, document.hasFocus(), "window");
window.addEventListener("focus", environment);
window.addEventListener("blur", environment);
document.addEventListener("visibilitychange", environment);
window.addEventListener("pagehide", () => owner.dispose(), { once: true });
environment();
const observed = new WeakSet<object>();
function discover() {
  for (const entry of owner.session.catalog.getSnapshot().entries) {
    const record = owner.session.record(entry);
    const store = record?.datasets;
    if (!store || observed.has(store)) continue;
    observed.add(store);
    store.subscribe(() => {
      for (const [id, start] of received) {
        if (!store.dataset(id) || store.revision(id) !== start.revision) continue;
        received.delete(id);
        // Conservative final-page-to-paint opportunity bound, including validation,
        // hash verification, cache installation and generic chart React update.
        requestAnimationFrame(() => {
          if (recording) apply.push(performance.now() - start.at);
        });
      }
    });
  }
}
owner.session.subscribe(discover);
owner.session.catalog.subscribe(discover);
function inspect() {
  const charts: unknown[] = [];
  let cacheBytes = 0,
    datasets = 0;
  for (const entry of owner.session.catalog.getSnapshot().entries) {
    const store = owner.session.record(entry)?.datasets;
    if (!store) continue;
    for (const id of [
      "chart0",
      "chart1",
      "chart2",
      "chart3",
      "history",
      "available",
      "profiles",
      "code",
    ]) {
      const data = store.dataset(id);
      if (!data) continue;
      datasets++;
      cacheBytes += canonicalDatasetV2Bytes(data.header, data.entries).length;
      if (data.header.kind === "chart") charts.push(data);
    }
  }
  return { charts, cacheBytes, datasets };
}
let cursorStart: number | undefined;
for (const type of ["pointerdown", "keydown"])
  document.addEventListener(
    type,
    (event) => {
      if (
        recording &&
        event.isTrusted &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "range"
      )
        cursorStart = performance.now();
    },
    true,
  );
owner.session.subscribe(() => {
  for (const entry of owner.session.catalog.getSnapshot().entries) {
    const interaction = owner.session.record(entry)?.interactions;
    if (!interaction || observed.has(interaction)) continue;
    observed.add(interaction);
    interaction.subscribe(() => {
      if (cursorStart === undefined || !interaction.getSnapshot().readings) return;
      const start = cursorStart;
      cursorStart = undefined;
      requestAnimationFrame(() => {
        if (recording) cursor.push(performance.now() - start);
      });
    });
  }
});
Object.assign(window, {
  labLoad: {
    inspect,
    start() {
      recording = true;
    },
    finish() {
      recording = false;
      return { apply, input, cursor };
    },
  },
});
Object.assign(globalThis, { MonacoEnvironment: { getWorker: () => new EditorWorker() } });
function LoadEditor() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const editor = monaco.editor.create(ref.current!, {
      value: "// W15 editor responsiveness\n".repeat(300),
      language: "plaintext",
      automaticLayout: true,
      minimap: { enabled: false },
    });
    let keyAt: number | undefined;
    const key = editor.onKeyDown((event) => {
      if (recording && event.browserEvent.isTrusted) keyAt = performance.now();
    });
    const change = editor.onDidChangeModelContent(() => {
      if (keyAt === undefined) return;
      const start = keyAt;
      keyAt = undefined;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (recording) input.push(performance.now() - start);
        }),
      );
    });
    return () => {
      key.dispose();
      change.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
    };
  }, []);
  return <div id="load-editor" ref={ref} style={{ height: 150, width: 640 }} />;
}
function Harness() {
  const { values } = useSettings();
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    document.documentElement.lang = values.locale;
  }, [values.locale]);
  return (
    <>
      <nav aria-label="Test shell">
        <LoadEditor />
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
