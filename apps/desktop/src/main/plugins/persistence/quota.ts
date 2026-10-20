const MiB = 1048576;
type Totals = { committed: number; records: number; metadata: number; temporary: number };
type Reservation = { source: string; bytes: number; create: boolean; metadata: number; lane: "write" | "export" | "metadata" };
export class QuotaLedger {
  private readonly committed = new Map<string, Totals>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly temporary = new Map<string, { source: string; bytes: number; refs: number }>();
  restore(source: string, totals: Totals): void { this.committed.set(source, { ...totals }); }
  private total(source: string): Totals { return this.committed.get(source) ?? { committed: 0, records: 0, metadata: 0, temporary: 0 }; }
  private sum(select: (v: Totals) => number): number { return [...this.committed.values()].reduce((a, v) => a + select(v), 0); }
  snapshot(source: string) {
    const c = this.total(source), all = [...this.reservations.values()], own = all.filter(r => r.source === source);
    const pending = (rs: Reservation[]) => rs.reduce((n, r) => n + r.bytes, 0);
    const tmp = [...this.temporary.values()].filter(r => r.source === source).reduce((n, r) => n + r.bytes, 0);
    return { recordCount: c.records, reservedCreates: own.filter(r => r.create).length, committedBytes: c.committed,
      reservedBytes: pending(own), pinnedBytes: tmp, temporaryBytes: c.temporary + tmp, sourceLimitBytes: 536870912 as const,
      sourceLimitRecords: 256 as const, hostAvailableBytes: Math.max(0, 1073741824 - this.sum(c => c.committed) - pending(all)),
      writeSlotsAvailable: Math.max(0, Math.min(2 - own.filter(r => r.lane === "write").length, 16 - all.filter(r => r.lane === "write").length)),
      exportSlotsAvailable: Math.max(0, Math.min(1 - own.filter(r => r.lane === "export").length, 4 - all.filter(r => r.lane === "export").length)) };
  }
  reserve(id: string, source: string, input: Omit<Reservation, "source">, availableBytes: number): void {
    if (this.reservations.has(id)) throw new Error("write-in-progress");
    for (const n of [input.bytes, input.metadata, availableBytes]) if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid-range");
    const s = this.snapshot(source), all = [...this.reservations.values()], own = all.filter(r => r.source === source);
    if (s.recordCount + s.reservedCreates + Number(input.create) > 256) throw new Error("record-count");
    if (s.committedBytes + s.reservedBytes + input.bytes > 512 * MiB) throw new Error("source-bytes");
    if (s.hostAvailableBytes < input.bytes) throw new Error("host-bytes");
    if ((input.lane === "write" && !s.writeSlotsAvailable) || (input.lane === "export" && !s.exportSlotsAvailable)) throw new Error("queue");
    if (this.total(source).metadata + own.reduce((n, r) => n + r.metadata, 0) + input.metadata > 4 * MiB || this.sum(t => t.metadata) + all.reduce((n, r) => n + r.metadata, 0) + input.metadata > 64 * MiB) throw new Error("metadata-limit");
    if (availableBytes - all.reduce((n, r) => n + r.bytes + r.metadata, 0) - input.bytes - input.metadata < 16 * MiB) throw new Error("disk-full");
    this.reservations.set(id, { source, ...input });
  }
  commit(id: string, delta: Totals): void {
    const r = this.reservations.get(id); if (!r) throw new Error("stale");
    const t = this.total(r.source);
    this.committed.set(r.source, { committed: t.committed + delta.committed, records: t.records + delta.records,
      metadata: t.metadata + delta.metadata, temporary: t.temporary + delta.temporary });
    this.reservations.delete(id);
  }
  release(id: string): void { this.reservations.delete(id); }
  adjustMetadata(source: string, delta: number): void { const current = this.total(source); this.committed.set(source, { ...current, metadata: current.metadata + delta }); }
  holdTemporary(source: string, key: string, bytes: number): void {
    const id = JSON.stringify([source, key]), existing = this.temporary.get(id);
    if (existing) { if (existing.bytes !== bytes) throw new Error("corrupt"); existing.refs++; return; }
    if (this.snapshot(source).temporaryBytes + bytes > 32 * MiB || this.sum(t => t.temporary) + [...this.temporary.values()].reduce((n, r) => n + r.bytes, 0) + bytes > 128 * MiB) throw new Error("temporary-bytes");
    this.temporary.set(id, { source, bytes, refs: 1 });
  }
  releaseTemporary(source: string, key: string): void {
    const id = JSON.stringify([source, key]), value = this.temporary.get(id);
    if (value && --value.refs === 0) this.temporary.delete(id);
  }
  hasTemporary(source: string, key: string): boolean { return this.temporary.has(JSON.stringify([source, key])); }
}
type Job = { source: string; bytes: number; deadline: number; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
export class WorkQueue {
  private readonly queue: Job[] = []; private readonly sourceBytes = new Map<string, number>();
  private readonly sourceCount = new Map<string, number>(); private active = 0; private bytes = 0; pending = 0;
  constructor(private readonly now: () => number) {}
  run<T>(source: string, bytes: number, deadline: number, run: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.pending >= 32 || this.bytes + bytes > 8388608 || (this.sourceBytes.get(source) ?? 0) + bytes > 1048576 || (this.sourceCount.get(source) ?? 0) >= 16) return Promise.reject(new Error("queue"));
    this.pending++; this.bytes += bytes; this.sourceBytes.set(source, (this.sourceBytes.get(source) ?? 0) + bytes); this.sourceCount.set(source, (this.sourceCount.get(source) ?? 0) + 1);
    const result = new Promise<unknown>((resolve, reject) => this.queue.push({ source, bytes, deadline, run, resolve, reject }));
    this.pump(); return result as Promise<T>;
  }
  private pump(): void {
    while (this.active < 4 && this.queue.length) {
      const job = this.queue.shift()!; this.active++;
      const work = this.now() >= job.deadline ? Promise.reject(new Error("timeout")) : job.run();
      void work.then(job.resolve, job.reject).finally(() => {
        this.active--; this.pending--; this.bytes -= job.bytes;
        this.sourceBytes.set(job.source, (this.sourceBytes.get(job.source) ?? 0) - job.bytes);
        this.sourceCount.set(job.source, (this.sourceCount.get(job.source) ?? 0) - 1); this.pump();
      });
    }
  }
}
