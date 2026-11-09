import { useSyncExternalStore, type ComponentProps } from "react";
import { TabList } from "../components/tab-list.js";
import { MonitorPanel } from "./monitor-panel.js";
import type { RendererSession } from "../plugin-ui/bootstrap.js";

export function MonitorWorkspace({
  plugins,
  onOpenTools,
  view,
  onView,
  ...props
}: ComponentProps<typeof MonitorPanel> & {
  plugins: Pick<RendererSession, "catalog" | "select">;
  onOpenTools(): void;
  view: "readings" | "lab";
  onView(view: "readings" | "lab"): void;
}): React.JSX.Element {
  const zh = props.locale === "zh-TW";
  const catalog = useSyncExternalStore(plugins.catalog.subscribe, plugins.catalog.getSnapshot);
  const labEntry = () =>
    plugins.catalog
      .getSnapshot()
      .entries.find(
        (entry) =>
          entry.kind === "panel" &&
          entry.sourceKey === "builtin:kobrixa.sensor-lab" &&
          entry.pluginId === "kobrixa.sensor-lab" &&
          entry.id === "kobrixa.sensor-lab.panel" &&
          entry.availability === "available",
      );
  const available = catalog.phase === "ready" && !!labEntry();
  return (
    <div className="monitor-workspace">
      <TabList
        className="monitor-subtabs"
        variant="compact"
        label={zh ? "監測工具" : "Monitor tools"}
        value={view}
        onChange={onView}
        tabs={(["readings", "lab"] as const).map((value) => ({
          value,
          id: `monitor-view-${value}`,
          panelId: `monitor-page-${value}`,
          label:
            value === "readings"
              ? zh
                ? "讀值"
                : "Readings"
              : zh
                ? "曲線與校正"
                : "Curves & calibration",
        }))}
      />
      <div
        id="monitor-page-readings"
        role="tabpanel"
        aria-labelledby="monitor-view-readings"
        hidden={view !== "readings"}
      >
        <MonitorPanel {...props} />
      </div>
      <div
        id="monitor-page-lab"
        role="tabpanel"
        aria-labelledby="monitor-view-lab"
        hidden={view !== "lab"}
      >
        <p role="status">
          {catalog.phase === "loading"
            ? zh
              ? "正在載入插件工具…"
              : "Loading plugin tools…"
            : available
              ? zh
                ? "曲線與校正已移至插件工具。"
                : "Curves and calibration are available in Plugin tools."
              : zh
                ? "Sensor Lab 目前無法使用。請至插件工具查看狀態。"
                : "Sensor Lab is unavailable. Check its status in Plugin tools."}
        </p>
        <button
          onClick={() => {
            // Re-read after a catalog change; never activate a retired or unavailable entry.
            const entry = plugins.catalog.getSnapshot().phase === "ready" ? labEntry() : undefined;
            if (entry) plugins.select(entry);
            onOpenTools();
          }}
        >
          {zh ? "前往插件工具" : "Go to Plugin tools"}
        </button>
      </div>
    </div>
  );
}
