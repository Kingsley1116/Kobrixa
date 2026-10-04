import type { Diagnostic } from "../../shared/api.js";
import type { Copy } from "../i18n/copy.js";
import { DiagnosticDetails, type DiagnosticDetailsHost } from "./diagnostic-details.js";
import { diagnosticSummary } from "../editor/diagnostic-presentation.js";
import "./diagnostics.css";

export function BottomPanel({
  t,
  open,
  onToggle,
  diagnostics,
  selected,
  checking,
  onJump,
  ...detailsHost
}: {
  t: Copy;
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
          <button aria-expanded={open} onClick={onToggle}>
            {open ? "⌄" : "›"} {t.diagnostics} <strong>{diagnostics.length}</strong>
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
      {open && (
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
    </section>
  );
}
