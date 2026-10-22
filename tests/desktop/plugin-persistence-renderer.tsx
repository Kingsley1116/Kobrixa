import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginToolsPane } from "../../apps/desktop/src/renderer/plugin-ui/panel-host.js";
import { PluginStatusHost } from "../../apps/desktop/src/renderer/plugin-ui/status-host.js";
import { CorePersistenceRecovery } from "../../apps/desktop/src/renderer/plugin-ui/core-persistence-detail.js";
import {
  SettingsControls,
  SettingsControlsView,
} from "../../apps/desktop/src/renderer/plugin-ui/forms.js";
import { mountContributedSettings170 } from "../../apps/desktop/src/renderer/settings/settings-panel.js";
import {
  pluginUiWindow,
  settingsStore,
  useSettings,
} from "../../apps/desktop/src/renderer/settings/settings-state.js";
import { pluginUiCopy } from "../../apps/desktop/src/renderer/settings/plugin-copy.js";
import { diagnosticsFor as hostDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/host-ports.js";
import { diagnosticsFor as stateDiagnostics } from "../../apps/desktop/src/renderer/plugin-ui/state-store.js";
import type { FoundationCounters, FoundationDiagnostics } from "@kobrixa/plugin-runtime";
import settingsResource from "./fixtures/plugin-persistence/settings.json?raw";
import "../../apps/desktop/src/renderer/styles/index.css";

// Acceptance shell only: all business operations use the production preload,
// renderer controls and window singleton. Exposed functions only observe/retire.
settingsStore.set("rightPanel", "plugins");
settingsStore.set("locale", "en");
const owner = pluginUiWindow();
const retained = new Map<object, FoundationDiagnostics>();
const controls = new Set<SettingsControls>();
const errors: string[] = [];
let disposed = false;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function retain(instance: object, lookup: (value: object) => FoundationDiagnostics) {
  if (!retained.has(instance)) retained.set(instance, lookup(instance));
}
retain(owner.host, hostDiagnostics);
retain(owner.session.catalog, stateDiagnostics);
function discover() {
  for (const entry of owner.session.catalog.getSnapshot().entries) {
    const record = owner.session.record(entry);
    if (record) retain(record.state, stateDiagnostics);
  }
}
const off = [owner.session.subscribe(discover), owner.session.catalog.subscribe(discover)];
function snapshot() {
  discover();
  const snapshot: { -readonly [K in keyof FoundationCounters]: FoundationCounters[K] } = {
    owners: 0,
    bindings: 0,
    subscriptions: 0,
    queuedEvents: 0,
    queuedBytes: 0,
    timers: 0,
    pendingInvocations: 0,
    actionTokens: 0,
    resourceReaders: 0,
    workerJobs: 0,
  };
  const raw = [...retained.values()].map((value, id) => ({ id, snapshot: value.snapshot() }));
  for (const row of raw)
    for (const key of Object.keys(snapshot) as (keyof FoundationCounters)[]) {
      const value = row.snapshot[key];
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`Invalid renderer counter ${key}`);
      snapshot[key] += value;
      if (!Number.isSafeInteger(snapshot[key])) throw new Error(`Renderer counter overflow ${key}`);
    }
  return {
    snapshot,
    raw,
    sampledAt: performance.timeOrigin + performance.now(),
    mountedSettings: [...controls].filter((control) => control.getSnapshot() !== null).length,
  };
}
const digest = crypto.subtle
  .digest("SHA-256", new TextEncoder().encode(settingsResource))
  .then((bytes) => [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join(""));
function Settings({ sourceKey, locale }: { sourceKey: string; locale: "en" | "zh-TW" }) {
  const [control] = useState(() => new SettingsControls());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    controls.add(control);
    let alive = true;
    let close = () => {};
    void digest.then((resourceDigest) => {
      if (!alive) return;
      close = mountContributedSettings170({
        api: window.kobrixa.plugins.settings,
        sourceKey,
        resourceDigest,
        controls: control,
        failure(error) {
          errors.push(String(error));
          if (alive) setFailed(true);
        },
      });
    });
    return () => {
      alive = false;
      close();
      control.destroy();
    };
  }, [control, sourceKey]);
  return (
    <section data-persistence-settings={sourceKey}>
      {failed && <p role="alert">{pluginUiCopy[locale].unavailable}</p>}
      <SettingsControlsView controls={control} locale={locale} labels={pluginUiCopy[locale]} />
    </section>
  );
}
function Shell() {
  const { values } = useSettings();
  const [source, setSource] = useState<string | null>(null);
  const labels = pluginUiCopy[values.locale];
  return (
    <>
      <nav aria-label="Persistence acceptance">
        {(["recording", "settings"] as const).map((role) => (
          <button
            key={role}
            data-persistence-open={role}
            onClick={() => setSource(`builtin:acceptance.ui-${role}`)}
          >
            Open {role} settings
          </button>
        ))}
        <button data-persistence-close onClick={() => setSource(null)}>
          Close settings
        </button>
      </nav>
      {source && <Settings key={source} sourceKey={source} locale={values.locale} />}
      <main style={{ height: "70vh", width: 640 }}>
        <PluginToolsPane
          session={owner.session}
          locale={values.locale}
          labels={labels}
          onClose={() => settingsStore.set("rightPanel", null)}
        />
        <PluginStatusHost session={owner.session} locale={values.locale} labels={labels} />
      </main>
      <CorePersistenceRecovery port={window.kobrixa.plugins.persistenceRecovery} labels={labels} />
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Shell />);
async function disposeFoundationRenderer() {
  if (!disposed) {
    disposed = true;
    root.unmount();
    owner.dispose();
    for (const detach of off.splice(0)) detach();
  }
  await frame();
  await frame();
  const final = snapshot();
  if (final.mountedSettings !== 0) throw new Error("Settings controls survived unmount");
  return final;
}
Object.assign(window, {
  declarativeAcceptance: {
    async foundationDiagnostics() {
      await owner.ready;
      await frame();
      return snapshot();
    },
    disposeFoundationRenderer,
  },
  persistenceAcceptance: {
    settingsSnapshot: () =>
      [...controls]
        .map((control) => control.getSnapshot())
        .filter(Boolean)
        .map((value) => structuredClone(value)),
    failures: () => [...errors],
  },
});
