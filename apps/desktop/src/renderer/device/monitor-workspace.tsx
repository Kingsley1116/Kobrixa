import type { ComponentProps } from "react";
import { TabList } from "../components/tab-list.js";
import { MonitorPanel } from "./monitor-panel.js";
import { SensorLabPanel } from "./sensor-lab-panel.js";
import type { SensorLabController } from "./sensor-lab-controller.js";

export function MonitorWorkspace({
  lab,
  view,
  onView,
  ...props
}: ComponentProps<typeof MonitorPanel> & {
  lab: SensorLabController;
  view: "readings" | "lab";
  onView(view: "readings" | "lab"): void;
}): React.JSX.Element {
  const zh = props.locale === "zh-TW";
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
        <SensorLabPanel
          controller={lab}
          monitor={props.controller}
          locale={props.locale}
          sessionId={props.sessionId}
          onConnect={props.onConnect}
          locked={props.locked ?? false}
        />
      </div>
    </div>
  );
}
