import { useEffect, useRef, useState } from "react";
import type { PersistenceRecoveryBridge } from "../../shared/plugin-persistence.js";
import type { PersistenceRecoverySnapshot } from "@kobrixa/plugin-runtime";
import type { UiLabels } from "./host-ports.js";
export type CorePersistenceDetailProps = {
  snapshot: PersistenceRecoverySnapshot; labels: UiLabels;
  onAction: (itemId: string, actionId: string) => Promise<void>;
};
export function CorePersistenceDetail({ snapshot, labels, onAction }: CorePersistenceDetailProps) {
  const [busy, setBusy] = useState<string[]>([]); const [failed, setFailed] = useState(false);
  const active = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current.clear(); }; }, []);
  return <section className="core-persistence-detail" aria-label={labels.recovery}>
    {failed && <p role="alert">{labels.unavailable}</p>}
    {snapshot.items.map((item) => <article key={item.id}><h3>{item.pluginId}</h3>
      {item.payload !== "complete-staging" && <p>{labels.checkpoint}</p>}
      {item.actions.filter((action) => action.kind !== "retry" || item.state === "retryable" && item.payload === "complete-staging").map((action) => <button key={action.id} disabled={busy.includes(item.id)} onClick={() => {
        if (active.current.has(item.id)) return; active.current.add(item.id); setBusy((items) => [...items, item.id]); setFailed(false);
        void Promise.resolve().then(() => onAction(item.id, action.id)).catch(() => { if (mounted.current) setFailed(true); }).finally(() => {
          active.current.delete(item.id); if (mounted.current) setBusy((items) => items.filter((id) => id !== item.id));
        });
      }}>{labels[action.kind]}</button>)}
    </article>)}
  </section>;
}

export function CorePersistenceRecovery({ port, labels }: { port: PersistenceRecoveryBridge; labels: UiLabels }) {
  const [snapshot, setSnapshot] = useState<PersistenceRecoverySnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const selected = useRef<string | null>(null);
  const serial = useRef(0);
  const live = useRef(false);
  async function refresh(): Promise<void> {
    const itemId = selected.current; if (!live.current || !itemId) return;
    const request = ++serial.current;
    try {
      const result = await port.snapshot({ itemId });
      if (!live.current || request !== serial.current) return;
      if (!result.ok) { setFailed(true); return; }
      setSnapshot(result.value); setFailed(false);
    } catch { if (live.current && request === serial.current) setFailed(true); }
  }
  useEffect(() => {
    live.current = true;
    const offChanged = port.onChanged(() => { void refresh(); });
    const offOpen = port.onOpen(({ itemId }) => {
      selected.current = itemId; setSnapshot(null); void refresh();
    });
    return () => { live.current = false; serial.current++; selected.current = null; offOpen(); offChanged(); };
  }, [port]);
  return <>{failed && <p role="alert">{labels.unavailable}</p>}
    {snapshot && <CorePersistenceDetail snapshot={snapshot} labels={labels} onAction={async (_recoveryId, optionId) => {
      const itemId = selected.current; if (!itemId || !live.current) return;
      const result = await port.act({ itemId, optionId });
      await refresh();
      if (!result.ok) throw new Error(result.error.code);
    }} />}</>;
}
