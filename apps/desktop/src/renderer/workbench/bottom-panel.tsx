import type { ReactNode } from "react";
import type { Diagnostic } from "../../shared/api.js";
import type { Copy } from "../i18n/copy.js";
import { DiagnosticDetails, type DiagnosticDetailsHost } from "./diagnostic-details.js";
import { diagnosticSummary } from "../editor/diagnostic-presentation.js";
import "./diagnostics.css";

export function BottomPanel({
  t,
  tab = "problems",
  onTab,
  activity,
  open,
  onToggle,
  diagnostics,
  selected,
  checking,
  onJump,
  ...detailsHost
}: {
  t: Copy;
  tab?: "problems" | "activity";
  onTab?(tab: "problems" | "activity"): void;
  activity?: ReactNode;
  open: boolean;
  onToggle(): void;
  diagnostics: Diagnostic[];
  selected: number;
  checking: boolean;
  onJump(item: Diagnostic, index: number): void;
} & DiagnosticDetailsHost): React.JSX.Element {
  return (
    <section className={`problems ${open ? "" : "collapsed"}`}>
      <div className="problems-header">
        <div className="bottom-tabs">
          <button
            aria-expanded={open && tab === "problems"}
            onClick={() => (tab === "problems" ? onToggle() : onTab?.("problems"))}
          >
            {open ? "⌄" : "›"} {detailsHost.locale === "zh-TW" ? "問題" : "Problems"}{" "}
            <strong>{diagnostics.length}</strong>
          </button>
          <button
            aria-expanded={open && tab === "activity"}
            onClick={() => (tab === "activity" ? onToggle() : onTab?.("activity"))}
          >
            {t.activity}
          </button>
        </div>
        <div className="diagnostic-summary">
          {checking && <span>{t.checking}</span>}
          <span className="error-count">
            {diagnostics.filter((item) => item.severity === "error").length} {t.errors}
          </span>
          <span className="warning-count">
            {diagnostics.filter((item) => item.severity === "warning").length} {t.warnings}
          </span>
        </div>
      </div>
      {open && tab === "problems" && (
        <div className={`problem-body ${diagnostics[selected] ? "with-details" : ""}`}>
          <div className="problem-list">
            {diagnostics.length ? (
              diagnostics.map((item, index) => (
                <button
                  className={selected === index ? "active" : ""}
                  key={`${item.code}-${index}`}
                  onClick={() => onJump(item, index)}
                >
                  <b className={item.severity}>{item.code}</b>
                  <span>{diagnosticSummary(item, detailsHost.locale)}</span>
                  <small>
                    {item.file}:{item.range.startLine}:{item.range.startColumn}
                  </small>
                </button>
              ))
            ) : (
              <p>{checking ? t.checking : t.noProblems}</p>
            )}
          </div>
          {diagnostics[selected] && (
            <DiagnosticDetails diagnostic={diagnostics[selected]!} {...detailsHost} />
          )}
        </div>
      )}
      <div className="bottom-activity" hidden={!open || tab !== "activity"}>
        {activity}
      </div>
    </section>
  );
}
