import type { SimulationSnapshot } from "../../shared/simulator.js";
import { TEAM_COLORS } from "./field-renderer.js";
import type { SimulatorCopy } from "./simulator-copy.js";

export function Scoreboard({
  t,
  snapshot,
  preparing,
  failed,
  durationMs,
  saveMessage,
  practice = false,
}: {
  t: SimulatorCopy;
  snapshot: SimulationSnapshot | null;
  preparing: boolean;
  failed: boolean;
  durationMs: number;
  saveMessage: string | null;
  /** The practice mat has no match clock or score, only elapsed time. */
  practice?: boolean;
}): React.JSX.Element {
  const state = preparing ? "preparing" : failed ? "error" : (snapshot?.status ?? "ready");
  const label = preparing
    ? t.preparing
    : failed
      ? t.error
      : snapshot
        ? t[snapshot.status]
        : t.ready;
  const time = snapshot?.timeMs ?? 0;
  // The world computes the opening score (normally 2–2) only once it is loaded; until then show
  // a placeholder instead of a misleading 0–0 that jumps on Start.
  const a = snapshot ? String(snapshot.score.A) : "–",
    b = snapshot ? String(snapshot.score.B) : "–";
  const progress = Math.min(1, durationMs > 0 ? time / durationMs : 0);
  return (
    <div className="sim-scoreboard" data-testid="simulator-scoreboard">
      <strong
        className="sim-state"
        data-testid="simulator-status"
        data-state={state}
        data-time-ms={time}
        aria-live="polite"
      >
        <i aria-hidden="true" />
        {label}
      </strong>
      {practice ? (
        <div className="sim-clock" role="timer" aria-label={t.elapsedOnly}>
          <span>
            <b>{(time / 1000).toFixed(2)}</b> s
          </span>
        </div>
      ) : (
        <>
          <div className="sim-clock">
            <span>
              <b>{(time / 1000).toFixed(2)}</b> / {(durationMs / 1000).toFixed(0)} s
            </span>
            <div
              className="sim-progress"
              role="progressbar"
              aria-label={t.elapsed}
              aria-valuemin={0}
              aria-valuemax={Math.round(durationMs / 1000)}
              aria-valuenow={Math.round(time / 1000)}
            >
              <div style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
          <div className="sim-score" aria-label={`${t.score}: A ${a}, B ${b}`}>
            <span style={{ color: TEAM_COLORS.A }}>A</span>
            <b>{a}</b>
            <span className="sim-score-sep">:</span>
            <b>{b}</b>
            <span style={{ color: TEAM_COLORS.B }}>B</span>
          </div>
          {snapshot?.practiceContinuation && <span className="sim-chip">{t.continued}</span>}
        </>
      )}
      {saveMessage && (
        <span className="sim-save-message" role="status">
          {saveMessage}
        </span>
      )}
    </div>
  );
}
