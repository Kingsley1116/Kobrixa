import { createHash } from "node:crypto";
import type { PluginContext } from "@kobrixa/plugin-sdk";
import {
  canonicalDatasetV2Bytes,
  type DeviceSessionSnapshot,
  type SourceCatalog,
  type ReadSnapshot,
  type DatasetRowV2,
  type UiBinding,
  type UiScalar,
  type ConnectionRecoverySnapshot,
} from "@kobrixa/plugin-protocol";
export function value<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
export const bounded = (s: string) => [...s.replace(/[\r\n\t]/g, " ")].slice(0, 1000).join("");
export function fresh(
  session: DeviceSessionSnapshot | undefined,
  sources: SourceCatalog | undefined,
  read: ReadSnapshot | undefined,
  received: number,
  now: number,
): boolean {
  const age = read?.ageMs;
  return (
    !!session &&
    session.state === "connected" &&
    session.foreground === "none" &&
    !session.recording &&
    !!sources &&
    sources.sessionId === session.sessionId &&
    sources.sourceRevision === session.sourceRevision &&
    read?.sessionId === session.sessionId &&
    read.status === "fresh" &&
    age !== null &&
    age !== undefined &&
    age >= 0 &&
    now >= received &&
    age + now - received <= 2500 &&
    read.frame?.status === "ok" &&
    read.frame.sourceRevision === sources.sourceRevision
  );
}
export function readings(
  sources: SourceCatalog | undefined,
  read: ReadSnapshot | undefined,
  received: number,
  now: number,
): DatasetRowV2[] {
  if (!sources) return [];
  const frame =
    read?.sessionId === sources.sessionId && read.frame?.sourceRevision === sources.sourceRevision
      ? read.frame
      : null;
  const age =
    read?.ageMs === null || read?.ageMs === undefined
      ? null
      : read.ageMs + Math.max(0, now - received);
  const live =
    read?.status === "fresh" && frame?.status === "ok" && age !== null && age >= 0 && age <= 2500;
  const rows: DatasetRowV2[] = sources.channels.map((c) => ({
    key: c.channelId,
    version: String(sources.sourceRevision),
    cells: [
      c.portId ?? c.kind,
      c.state === "unknown" ? "unsupported" : c.state,
      live
        ? String(frame?.values.find((v) => v.channelId === c.channelId)?.value ?? "Unavailable")
        : read?.status === "busy"
          ? "Waiting"
          : "Unavailable",
      c.unit,
      age === null ? "Unknown" : String(Math.floor(age)),
    ],
  }));
  // Missing channel metadata cannot establish that a port is empty.
  for (const kind of ["input", "output"] as const)
    for (let port = 0; port < 4; port++) {
      const portId = `${kind}:${port}`;
      if (!sources.channels.some((c) => c.portId === portId))
        rows.push({
          key: portId,
          version: String(sources.sourceRevision),
          cells: [portId, "unavailable", "Unavailable", "", "Unknown"],
        });
    }
  return rows;
}
export function recoveryText(snapshot: ConnectionRecoverySnapshot | undefined): string {
  const r = snapshot?.recovery;
  if (!r)
    return snapshot
      ? "No connection recovery / 無連線復原"
      : "Recovery unavailable / 無法讀取復原狀態";
  return bounded(
    `${r.name}: ${r.phase} · ${r.attemptsStarted}/${r.retryLimit}${r.phase === "waiting" ? ` · ${r.retryAfterMs} ms` : ""}${"reason" in r ? ` · ${r.reason}` : ""}${r.phase === "cancel-failed" ? ` · ${r.error.message}` : ""}`,
  );
}
/** One serialized writer per process, <=1 publication/second per view. */
export async function publish(
  ui: PluginContext["ui"],
  binding: UiBinding & { kind: "panel" },
  datasets: Record<string, DatasetRowV2[]>,
  set: Record<string, UiScalar>,
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const before = value(await ui.state(binding, signal));
  if (!before.visible) throw new Error("Panel hidden");
  const metadata = value(await ui.data.snapshot(binding, signal));
  const presentation =
    Math.max(Number(before.data.presentation), ...metadata.datasets.map((d) => d.presentation)) + 1;
  if (!Number.isSafeInteger(presentation)) throw new Error("Presentation exhausted");
  const revisions = new Map<string, number>();
  for (const [dataset, entries] of Object.entries(datasets)) {
    const header = { kind: "table" as const };
    const bytes = canonicalDatasetV2Bytes(header, entries);
    let transfer: string | undefined;
    try {
      transfer = value(
        await ui.data.begin(
          {
            binding,
            dataset,
            baseRevision: metadata.datasets.find((d) => d.dataset === dataset)?.revision ?? 0,
            presentation,
            header,
            entryCount: entries.length,
            byteLength: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          signal,
        ),
      ).transfer;
      signal.throwIfAborted();
      if (entries.length)
        value(
          await ui.data.chunk(
            { binding, dataset, transfer, offset: 0, chunk: { kind: "table", entries } },
            signal,
          ),
        );
      revisions.set(
        dataset,
        value(await ui.data.commit({ binding, dataset, transfer }, signal)).revision,
      );
      transfer = undefined;
    } finally {
      if (transfer) await ui.data.abort({ binding, dataset, transfer }).catch(() => {});
    }
  }
  signal.throwIfAborted();
  const current = value(await ui.state(binding, signal));
  if (!current.visible || current.data.presentation !== before.data.presentation)
    throw new Error("Presentation changed");
  value(await ui.patch(binding, current.revision, { ...set, presentation }, signal));
  return revisions;
}
