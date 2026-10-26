import { useSyncExternalStore } from "react";
import type { DatasetV2, PanelResourceV2, UiNodeV2 } from "@kobrixa/plugin-protocol";
import type { UiDatasetStore } from "./data-store.js";
import { DatasetChart, DatasetCode, DatasetTable } from "./dataset-views.js";
import { translated } from "./recovery-support.js";
import type { UiInteractionStore, InteractionView } from "./interaction-store.js";
const noInteraction: InteractionView = {
  view: null,
  busy: false,
  requestedCursor: null,
  readings: null,
  problem: null,
};
const noSnapshot = () => noInteraction;
const noSubscribe = () => () => {};
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
  interactions,
  enabled = false,
  current = true,
}: {
  node: Node;
  resource: PanelResourceV2;
  store: UiDatasetStore;
  locale: "en" | "zh-TW";
  interactions?: UiInteractionStore;
  enabled?: boolean;
  current?: boolean;
}) {
  const interaction = useSyncExternalStore(
    interactions?.subscribe ?? noSubscribe,
    interactions?.getSnapshot ?? noSnapshot,
    interactions?.getSnapshot ?? noSnapshot,
  );
  const status = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const data = store.dataset(node.dataset);
  const revision = store.revision(node.dataset);
  const declaration = resource.datasets[node.dataset];
  const label = translated(node.label, locale);
  const unavailable = !status.active || status.unavailable;
  const active = enabled && !!interaction.view && !interaction.busy && !unavailable;
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
  if (!current || !data || !declaration || revision === undefined) return pending;
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
      <>
        {node.timeView === "inspect" && interactions && (
          <label>
            {locale === "zh-TW" ? "時間範圍" : "Time view"}
            <select
              disabled={!active}
              value={interaction.view?.inspectView ?? data.header.view}
              onChange={(event) => {
                void interactions.act({
                  kind: "chartView",
                  nodeId: node.id,
                  view: event.target.value === "recent60s" ? "recent60s" : "full",
                });
              }}
            >
              <option value="full">{locale === "zh-TW" ? "全部" : "Full"}</option>
              <option value="recent60s">
                {locale === "zh-TW" ? "最近 60 秒" : "Recent 60 seconds"}
              </option>
            </select>
          </label>
        )}
        <DatasetChart
          label={label}
          declaration={declaration}
          header={data.header}
          points={data.entries}
          locale={locale}
          cursor={interaction.requestedCursor}
          enabled={active}
          view={
            node.timeView === "inspect"
              ? (interaction.view?.inspectView ?? data.header.view)
              : data.header.view
          }
          {...(interactions
            ? {
                onCursor: (time: number | null) => interactions.cursor(node.id, node.dataset, time),
              }
            : {})}
        />
        {interaction.readings && (
          <table aria-label={`${label}: ${locale === "zh-TW" ? "游標讀值" : "Cursor readings"}`}>
            <thead>
              <tr>
                <th>{locale === "zh-TW" ? "序列" : "Series"}</th>
                <th>{locale === "zh-TW" ? "原始值" : "Raw"}</th>
                <th>{locale === "zh-TW" ? "校正值" : "Calibrated"}</th>
              </tr>
            </thead>
            <tbody>
              {node.onCursor.readings
                .filter((r) => r.dataset === node.dataset)
                .map((r) => (
                  <tr key={r.series}>
                    <th scope="row">
                      {translated(declaration.series.find((s) => s.id === r.series)!.label, locale)}
                    </th>
                    <td>{interaction.readings?.[r.rawKey] ?? "—"}</td>
                    <td>{interaction.readings?.[r.valueKey] ?? "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </>
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
        enabled={active}
        {...(interactions && node.type === "table" && node.onSelect
          ? {
              onSelect: (row: { key: string; revision: number }) => {
                void interactions.act({
                  kind: "row",
                  nodeId: node.id,
                  dataset: node.dataset,
                  revision: row.revision,
                  key: row.key,
                });
              },
            }
          : {})}
        {...(interactions && node.type === "list"
          ? {
              actions: node.actions.map((action) => ({
                id: action.id,
                label: translated(action.label, locale),
                select: (row: { key: string; revision: number }) => {
                  void interactions.act({
                    kind: "list",
                    nodeId: node.id,
                    actionId: action.id,
                    dataset: node.dataset,
                    revision: row.revision,
                    key: row.key,
                  });
                },
              })),
            }
          : {})}
      />
    );
  if (node.type === "code" && declaration.kind === "code" && code(data))
    return (
      <DatasetCode
        label={label}
        entries={data.entries}
        locale={locale}
        enabled={active}
        {...(interactions
          ? {
              onCopy: () => {
                void interactions.act({
                  kind: "codeCopy",
                  nodeId: node.id,
                  dataset: node.dataset,
                  revision,
                });
              },
            }
          : {})}
      />
    );
  throw new Error("Dataset node kind mismatch");
}
