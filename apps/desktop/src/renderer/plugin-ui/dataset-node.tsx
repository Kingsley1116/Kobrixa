import { useSyncExternalStore } from "react";
import type { DatasetV2, PanelResourceV2, UiNodeV2 } from "@kobrixa/plugin-protocol";
import type { UiDatasetStore } from "./data-store.js";
import { DatasetChart, DatasetCode, DatasetTable } from "./dataset-views.js";
import { translated } from "./recovery-support.js";
type Node = Extract<UiNodeV2, { type: "lineChart" | "table" | "list" | "code" }>;
function chart(data: DatasetV2): data is Extract<DatasetV2, { header: { kind: "chart" } }> {
  return data.header.kind === "chart";
}
function rows(data: DatasetV2): data is Extract<DatasetV2, { header: { kind: "table" | "list" } }> {
  return data.header.kind === "table" || data.header.kind === "list";
}
function code(data: DatasetV2): data is Extract<DatasetV2, { header: { kind: "code" } }> {
  return data.header.kind === "code";
}
/** Read presentation of an admitted node. Action admission is supplied separately
 * by the host; receiving or rendering a dataset never dispatches a command. */
export function DatasetNodeView({
  node,
  resource,
  store,
  locale,
}: {
  node: Node;
  resource: PanelResourceV2;
  store: UiDatasetStore;
  locale: "en" | "zh-TW";
}) {
  const status = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const data = store.dataset(node.dataset);
  const revision = store.revision(node.dataset);
  const declaration = resource.datasets[node.dataset];
  const label = translated(node.label, locale);
  const unavailable = !status.active || status.unavailable;
  const pending = (
    <p role="status">
      {unavailable
        ? locale === "zh-TW"
          ? "無法使用"
          : "Unavailable"
        : locale === "zh-TW"
          ? "更新中…"
          : "Updating…"}
    </p>
  );
  if (!data || !declaration || revision === undefined) return pending;
  if (node.type === "lineChart" && declaration.kind === "chart" && chart(data)) {
    const group = [
      ...new Set(
        resource.nodes
          .filter(
            (candidate) =>
              candidate.type === "lineChart" && candidate.cursorGroup === node.cursorGroup,
          )
          .map((candidate) => ("dataset" in candidate ? candidate.dataset : "")),
      ),
    ];
    if (!store.chartGroup(group)) return pending;
    return (
      <DatasetChart
        label={label}
        declaration={declaration}
        header={data.header}
        points={data.entries}
        locale={locale}
        cursor={null}
        enabled={false}
      />
    );
  }
  if (
    (node.type === "table" || node.type === "list") &&
    (declaration.kind === "table" || declaration.kind === "list") &&
    rows(data)
  )
    return (
      <DatasetTable
        label={label}
        declaration={declaration}
        rows={data.entries}
        locale={locale}
        revision={revision}
        enabled={false}
      />
    );
  if (node.type === "code" && declaration.kind === "code" && code(data))
    return <DatasetCode label={label} entries={data.entries} locale={locale} enabled={false} />;
  throw new Error("Dataset node kind mismatch");
}
