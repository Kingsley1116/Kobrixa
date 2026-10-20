import { useSyncExternalStore } from "react";
import { TabList } from "../components/tab-list.js";
import type { RendererSession } from "./bootstrap.js";
import type { UiLabels } from "./host-ports.js";
import { contributionKey } from "./catalog-store.js";
import { ContributionBoundary, PanelTree, translated } from "./components.js";
export function PluginToolsPane({ session, locale, labels, onClose }: { session: RendererSession; locale: "en" | "zh-TW"; labels: UiLabels; onClose: () => void }) {
  const catalog = useSyncExternalStore(session.catalog.subscribe, session.catalog.getSnapshot);
  useSyncExternalStore(session.subscribe, session.getSnapshot);
  const panels = catalog.entries.filter((entry) => entry.kind === "panel").sort((a, b) => {
    const left = `${a.pluginId}\0${a.id}`, right = `${b.pluginId}\0${b.id}`; return left < right ? -1 : left > right ? 1 : 0;
  });
  const selected = panels.find((entry) => contributionKey(entry) === session.selectedKey()) ?? panels[0];
  const record = selected && session.record(selected);
  return <section className="plugin-tools-pane" aria-label={labels.tools}>
    <header><h2>{labels.tools}</h2><button onClick={() => { session.showPane(false, "collapse"); onClose(); }}>{labels.close}</button></header>
    {panels.length > 0 ? <TabList label={labels.tools} variant="compact" value={selected ? contributionKey(selected) : ""}
      tabs={panels.map((entry, index) => ({ value: contributionKey(entry), label: translated(entry.title, locale), id: `plugin-tab-${index}`, panelId: `plugin-panel-${index}` }))}
      onChange={(key) => { const entry = panels.find((item) => contributionKey(item) === key); if (entry) { session.select(entry); void session.open(entry); } }} /> : <p>{catalog.phase === "loading" ? labels.loading : labels.empty}</p>}
    {selected && <section id={`plugin-panel-${panels.indexOf(selected)}`} role="tabpanel" aria-labelledby={`plugin-tab-${panels.indexOf(selected)}`}>
      {selected.availability === "unavailable" || session.failed(selected) ? <p role="alert">{labels.unavailable}{selected.problem && `: ${selected.problem.code}`}</p>
        : record ? <ContributionBoundary key={`${record.state.form().binding.panelInstance}:${selected.uiResourceGeneration}`} onFailure={() => session.quarantine(selected, "renderer")} fallback={labels.unavailable}>
          <PanelTree state={record.state} intent={record.intent} locale={locale} labels={labels} />
          <button data-close-contribution="true" onClick={() => session.close(selected)}>{labels.close}</button>
        </ContributionBoundary> : <button onClick={() => void session.open(selected)}>{labels.open}</button>}
    </section>}
  </section>;
}
