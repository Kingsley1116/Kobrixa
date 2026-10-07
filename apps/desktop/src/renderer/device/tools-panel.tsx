import type { ReactNode } from "react";
import { TabList } from "../components/tab-list.js";
import type { Locale, Copy } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
export type ToolTab = "connection" | "monitor" | "files" | "activity" | "collab";
const labels = {
  en: {
    tools: "EV3 tools",
    connection: "Connection",
    monitor: "Monitor",
    files: "EV3 files",
    activity: "Activity",
    collab: "Collaborate",
    close: "Close tools",
  },
  "zh-TW": {
    tools: "EV3 工具",
    connection: "連線",
    monitor: "監測",
    files: "EV3 檔案",
    activity: "操作紀錄",
    collab: "協作",
    close: "關閉工具面板",
  },
};
export function ToolsPanel({
  tab,
  onTab,
  locale,
  onClose,
  connection,
  monitor,
  files,
  activity,
  collab,
}: {
  tab: ToolTab;
  onTab(tab: ToolTab): void;
  locale: Locale;
  onClose(): void;
  connection: ReactNode;
  monitor: ReactNode;
  files: ReactNode;
  activity: ReactNode;
  collab: ReactNode;
}): React.JSX.Element {
  const t = labels[locale],
    tabs: ToolTab[] = ["connection", "monitor", "files", "activity", "collab"];
  return (
    <>
      <div className="tools-heading">
        <h2>{t.tools}</h2>
        <button aria-label={t.close} onClick={onClose}>
          ×
        </button>
      </div>
      <TabList
        className="tools-tabs"
        label={t.tools}
        value={tab}
        onChange={onTab}
        tabs={tabs.map((value) => ({
          value,
          label: t[value],
          id: `tool-tab-${value}`,
          panelId: `tool-panel-${value}`,
        }))}
      />
      {tabs.map((value) => (
        <div
          className={`tool-content ${value === "files" ? "files-content" : ""}`}
          key={value}
          id={`tool-panel-${value}`}
          role="tabpanel"
          aria-labelledby={`tool-tab-${value}`}
          hidden={tab !== value}
          tabIndex={0}
        >
          {value === "connection"
            ? connection
            : value === "monitor"
              ? monitor
              : value === "files"
                ? files
                : value === "activity"
                  ? activity
                  : collab}
        </div>
      ))}
    </>
  );
}
export function ActivityPanel({
  t,
  locale,
  state,
}: {
  t: Copy;
  locale: Locale;
  state: ExecutionState;
}): React.JSX.Element {
  return (
    <div className="activity-list" role="log" aria-label={t.activity}>
      {!state.logs.length && <p>{t.noActivity}</p>}
      {[...state.logs].reverse().map((entry) => (
        <div className={`activity-row ${entry.failed ? "failed" : ""}`} key={entry.id}>
          <time>{new Date(entry.time).toLocaleTimeString(locale, { hour12: false })}</time>
          <div>
            <span>
              {entry.failed ? `${t.phases.error} · ` : ""}
              {t.messages[entry.message]}
            </span>
            {entry.detail && <pre>{entry.detail}</pre>}
          </div>
        </div>
      ))}
    </div>
  );
}
