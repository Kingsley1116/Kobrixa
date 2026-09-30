import type { Diagnostic } from "../../shared/api.js";
import type { Copy } from "../i18n/copy.js";

export function BottomPanel({
  t,
  open,
  onToggle,
  diagnostics,
  selected,
  checking,
  onJump,
}: {
  t: Copy;
  open: boolean;
  onToggle(): void;
  diagnostics: Diagnostic[];
  selected: number;
  checking: boolean;
  onJump(item: Diagnostic, index: number): void;
}): React.JSX.Element {
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
        <div className="problem-list">
          {diagnostics.length ? (
            diagnostics.map((item, index) => (
              <button
                className={selected === index ? "active" : ""}
                key={`${item.code}-${index}`}
                onClick={() => onJump(item, index)}
              >
                <b className={item.severity}>{item.code}</b>
                <span>{item.message}</span>
                <small>
                  {item.file}:{item.range.startLine}:{item.range.startColumn}
                </small>
              </button>
            ))
          ) : (
            <p>{checking ? t.checking : t.noProblems}</p>
          )}
        </div>
      )}
    </section>
  );
}
