import { useEffect, useState } from "react";

export const LOG_POLL_MS = 1_000;
const DISPLAY_LINES = 2_000;
type Entry = { key: string; text: string; gap: boolean };

/** Reads one source's log from main in batches while it is open; nothing streams per line. */
export function PluginLog({
  sourceKey,
  labels,
}: {
  sourceKey: string;
  labels: { title: string; empty: string; truncated: string };
}): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    let live = true;
    let cursor = 0;
    let gaps = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const read = await window.kobrixa.plugins.readLog(sourceKey, cursor);
        if (!live) return;
        const batch: Entry[] = [];
        if (read.truncated) batch.push({ key: `gap-${gaps++}`, text: "", gap: true });
        for (const line of read.lines)
          batch.push({ key: String(line.seq), text: line.text, gap: false });
        cursor = read.next;
        if (batch.length) setEntries((list) => [...list, ...batch].slice(-DISPLAY_LINES));
      } catch {
        // Try again on the next tick; the panel shows what it already has.
      }
      if (live) timer = setTimeout(() => void poll(), LOG_POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sourceKey]);
  return (
    <div className="plugins-log" role="log" aria-label={labels.title}>
      {entries.length === 0 ? (
        <p className="settings-hint">{labels.empty}</p>
      ) : (
        <pre>
          {entries.map((entry) => (
            <span key={entry.key} className={entry.gap ? "plugins-log-gap" : undefined}>
              {entry.gap ? labels.truncated : entry.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
