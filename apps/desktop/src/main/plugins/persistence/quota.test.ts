import { expect, it } from "vitest";
import { QuotaLedger, WorkQueue } from "./quota.js";
const GiB = 1073741824, MiB = 1048576;
it("reserves full payload atomically and keeps old+new during replacement", () => {
  const q = new QuotaLedger(); q.restore("s", { committed: 504 * MiB, records: 63, metadata: 0, temporary: 0 });
  q.reserve("a", "s", { bytes: 8 * MiB, create: true, metadata: 0, lane: "write" }, GiB * 4);
  expect(() => q.reserve("b", "s", { bytes: 1, create: false, metadata: 0, lane: "write" }, GiB * 4)).toThrow("source-bytes");
  expect(q.snapshot("s").reservedBytes).toBe(8 * MiB);
  q.release("a");
  q.restore("t", { committed: 512 * MiB, records: 64, metadata: 0, temporary: 0 });
  expect(() => q.reserve("c", "s", { bytes: 8 * MiB + 1, create: false, metadata: 0, lane: "write" }, GiB * 4)).toThrow();
});
it("enforces count, host, scratch, metadata, slots and physical headroom", () => {
  const full = new QuotaLedger(); full.restore("s", { committed: 0, records: 256, metadata: 0, temporary: 0 });
  expect(() => full.reserve("a", "s", { bytes: 0, create: true, metadata: 0, lane: "write" }, GiB)).toThrow("record-count");
  const q = new QuotaLedger(); q.restore("a", { committed: 512 * MiB, records: 64, metadata: 0, temporary: 0 });
  q.restore("b", { committed: 512 * MiB, records: 64, metadata: 0, temporary: 0 });
  expect(() => q.reserve("x", "c", { bytes: 1, create: true, metadata: 0, lane: "write" }, GiB * 4)).toThrow("host-bytes");
  const p = new QuotaLedger();
  p.holdTemporary("s", "old", 32 * MiB);
  p.holdTemporary("s", "old", 32 * MiB); // references, not duplicate byte charges
  expect(p.snapshot("s").temporaryBytes).toBe(32 * MiB);
  expect(() => p.holdTemporary("s", "other", 1)).toThrow("temporary-bytes");
  for (const source of ["a", "b", "c"]) p.holdTemporary(source, source, 32 * MiB);
  expect(() => p.holdTemporary("d", "d", 1)).toThrow("temporary-bytes");
  expect(() => p.reserve("m", "m", { bytes: 0, create: false, metadata: 4 * MiB + 1, lane: "metadata" }, GiB)).toThrow("metadata-limit");
  const disk = new QuotaLedger();
  expect(() => disk.reserve("d", "d", { bytes: 1, create: false, metadata: 0, lane: "write" }, 16 * MiB)).toThrow("disk-full");
  for (let i = 0; i < 16; i++) disk.reserve(`w${i}`, `s${Math.floor(i / 2)}`, { bytes: 1, create: true, metadata: 0, lane: "write" }, GiB);
  expect(() => disk.reserve("w16", "new", { bytes: 1, create: true, metadata: 0, lane: "write" }, GiB)).toThrow("queue");
});
it("limits work before invoking decoder and caps active I/O jobs at four", async () => {
  const q = new WorkQueue(() => 0), releases: Array<() => void> = [];
  let decoded = 0, active = 0, peak = 0;
  const jobs = Array.from({ length: 32 }, (_, i) => q.run(`s${i}`, 262144, 10000, async () => {
    decoded++; active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.push(resolve)); active--; return i;
  }));
  await expect(q.run("extra", 1, 10000, async () => { decoded++; })).rejects.toThrow("queue");
  expect(decoded).toBe(4); expect(peak).toBe(4);
  while (q.pending) { releases.splice(0).forEach(release => release()); await new Promise(resolve => setTimeout(resolve, 0)); }
  expect(await Promise.all(jobs)).toHaveLength(32);
  const one = new WorkQueue(() => 0);
  await expect(one.run("s", 1048577, 10000, async () => {})).rejects.toThrow("queue");
});
