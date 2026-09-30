import { useRef, type ReactNode } from "react";
import type { Locale, Copy } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
export type ToolTab = "connection" | "files" | "activity";
const labels = {
  en: {
    tools: "EV3 tools",
    connection: "Connection",
    files: "EV3 files",
    activity: "Activity",
    close: "Close tools",
  },
  "zh-TW": {
    tools: "EV3 工具",
    connection: "連線",
    files: "EV3 檔案",
    activity: "操作紀錄",
    close: "關閉工具面板",
  },
};
export function ToolsPanel({
  tab,
  onTab,
  locale,
  onClose,
  connection,
  files,
  activity,
}: {
  tab: ToolTab;
  onTab(tab: ToolTab): void;
  locale: Locale;
  onClose(): void;
  connection: ReactNode;
  files: ReactNode;
  activity: ReactNode;
}): React.JSX.Element {
  const t = labels[locale],
    tabs: ToolTab[] = ["connection", "files", "activity"];
  const bar = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="tools-heading">
        <h2>{t.tools}</h2>
        <button aria-label={t.close} onClick={onClose}>
          ×
        </button>
      </div>
      <div
        className="tools-tabs"
        data-active-tab={tab}
        role="tablist"
        aria-label={t.tools}
        ref={bar}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? 2
                : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : 2)) % 3;
          onTab(tabs[index]!);
          bar.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
        }}
      >
        {tabs.map((value) => (
          <button
            key={value}
            id={`tool-tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`tool-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => onTab(value)}
          >
            {t[value]}
          </button>
        ))}
      </div>
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
          {value === "connection" ? connection : value === "files" ? files : activity}
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
