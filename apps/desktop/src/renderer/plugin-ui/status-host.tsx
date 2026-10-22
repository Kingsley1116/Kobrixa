import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { StatusResourceV1, UiCatalogEntry } from "@kobrixa/plugin-protocol";
import { assertRenderable, type RendererSession, type PanelRecord } from "./bootstrap.js";
import { contributionKey } from "./catalog-store.js";
import { condition } from "./state-store.js";
import { ContributionBoundary, LiveText, displayText, translated } from "./components.js";
import type { UiLabels } from "./host-ports.js";
function BoundStatus({ record, resource, locale, labels }: { record: PanelRecord; resource: StatusResourceV1; locale: "en" | "zh-TW"; labels: UiLabels }) {
  const view = useSyncExternalStore(record.state.subscribe, record.state.getSnapshot);
  useLayoutEffect(() => record.state.renderCommitted(view.snapshot.revision), [record.state, view.snapshot.revision]);
  if (!view.active || !condition(resource.visibleWhen, view.snapshot.data, {})) return null;
  if (view.problem) return <span role="alert">{labels.unavailable}</span>;
  return <span data-tone={resource.tone}><LiveText text={displayText(resource.text, view.snapshot.data, locale)} /></span>;
}
function InitialStatus({ resource, locale }: { resource: StatusResourceV1; locale: "en" | "zh-TW" }) {
  const data = Object.fromEntries(Object.entries(resource.data).map(([key, field]) => [key, field.initial]));
  if (!condition(resource.visibleWhen, data, {})) return null;
  return <span data-tone={resource.tone}><LiveText text={displayText(resource.text, data, locale)} /></span>;
}
function StatusItem({ session, entry, locale, labels }: { session: RendererSession; entry: UiCatalogEntry; locale: "en" | "zh-TW"; labels: UiLabels }) {
  const [resource, setResource] = useState<StatusResourceV1 | null>(null);
  useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    let live = true;
    void session.catalog.resource(entry).then((value) => {
      if (!live || !session.catalog.current(entry)) return;
      try { if (value?.resource.kind === "status") { assertRenderable(value.resource, value.validationContext, value.rawBytes); setResource(value.resource); } }
      catch { session.quarantine(entry, "validation"); }
    }).catch(() => { if (live) session.quarantine(entry, "renderer"); });
    return () => { live = false; };
  }, [session, entry]);
  if (entry.availability === "unavailable" || session.failed(entry) || session.statusUnavailable(entry)) return <span role="status">{translated(entry.title, locale)}: {labels.unavailable}</span>;
  if (!resource) return null;
  const record = session.record(entry);
  return <ContributionBoundary onFailure={() => session.quarantine(entry, "renderer")} fallback={labels.unavailable}>
    <span title={translated(entry.title, locale)}>{record ? <BoundStatus record={record} resource={resource} locale={locale} labels={labels} />
      : <InitialStatus resource={resource} locale={locale} />}</span>
  </ContributionBoundary>;
}
export function PluginStatusHost({ session, locale, labels }: { session: RendererSession; locale: "en" | "zh-TW"; labels: UiLabels }) {
  const catalog = useSyncExternalStore(session.catalog.subscribe, session.catalog.getSnapshot);
  const entries = catalog.entries.filter((entry) => entry.kind === "status");
  return <div className="plugin-status-host">{entries.slice(0, 3).map((entry) => <StatusItem key={`${contributionKey(entry)}:${entry.uiResourceGeneration}`} session={session} entry={entry} locale={locale} labels={labels} />)}
    {entries.length > 3 && <details><summary>{labels.tools} (+{entries.length - 3})</summary><div className="plugin-status-overflow">{entries.slice(3).map((entry) => <StatusItem key={`${contributionKey(entry)}:${entry.uiResourceGeneration}`} session={session} entry={entry} locale={locale} labels={labels} />)}</div></details>}
  </div>;
}
