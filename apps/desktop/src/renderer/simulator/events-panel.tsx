import { useState } from "react";
import type { SourceSpan } from "@kobrixa/ir";
import type { SimulationEvent, SimulationScene } from "../../shared/simulator.js";
import type { SimulatorCopy } from "./simulator-copy.js";

type Kind = SimulationEvent["kind"];
const KINDS: Kind[] = ["error", "violation", "collision", "score", "info"];

export function EventsPanel({
  t,
  events,
  scene,
  onSource,
}: {
  t: SimulatorCopy;
  events: readonly SimulationEvent[];
  scene: SimulationScene;
  onSource?(span: SourceSpan): void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<Kind | "all">("all");
  const labels: Record<Kind, string> = {
    error: t.errorEvent,
    violation: t.violation,
    collision: t.collision,
    score: t.scoreEvent,
    info: t.info,
  };
  const counts = new Map<Kind, number>();
  for (const event of events) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  const shown = [...events].reverse().filter((event) => filter === "all" || event.kind === filter);
  if (!events.length) return <p className="sim-empty">{t.noEvents}</p>;
  return (
    <>
      <div className="sim-filters" role="group" aria-label={t.events}>
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          {t.allEvents} <small>{events.length}</small>
        </button>
        {KINDS.filter((kind) => counts.has(kind)).map((kind) => (
          <button
            key={kind}
            type="button"
            data-kind={kind}
            aria-pressed={filter === kind}
            onClick={() => setFilter(kind)}
          >
            <i className="sim-dot" data-kind={kind} aria-hidden="true" />
            {labels[kind]} <small>{counts.get(kind)}</small>
          </button>
        ))}
      </div>
      <ol className="sim-events">
        {shown.map((event) => {
          const robot = scene.robots.find((item) => item.id === event.robotId);
          return (
            <li key={event.id} data-kind={event.kind}>
              <i className="sim-dot" data-kind={event.kind} aria-hidden="true" />
              <div>
                <header>
                  <time>{(event.timeMs / 1000).toFixed(2)} s</time>
                  <strong>{robot ? `${robot.id} · ${robot.name}` : labels[event.kind]}</strong>
                </header>
                <p>{event.message}</p>
                {event.span && onSource && (
                  <button type="button" className="sim-link" onClick={() => onSource(event.span!)}>
                    {t.source} · {event.span.file}:{event.span.start.line}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
