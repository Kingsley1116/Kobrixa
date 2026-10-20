import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { SafetyFaultEntry } from "@kobrixa/plugin-runtime";
import { createJournal, journalDocument, parseJournal } from "./journal.js";
import type { JournalFilesystem } from "./journal-filesystem.js";

function entry(patch: Partial<SafetyFaultEntry> = {}): SafetyFaultEntry {
  return {
    id: randomUUID(), revision: 1,
    owner: { kind: "core", adapter: "motor", hostEpoch: randomUUID(), workbenchInstance: randomUUID() },
    providerId: "kobrixa.device-ev3", providerGeneration: 1,
    physical: { providerId: "kobrixa.device-ev3", family: "ev3", basis: "serial", digest: "a".repeat(64), strength: "stable" },
    sessionId: randomUUID(), operationId: randomUUID(), operationClass: "finite-motion",
    createdAt: 1, updatedAt: 1, state: "pending", dispatch: "not-sent",
    movement: "not-started", stopRequested: false, stopConfirmation: "pending", cause: "none", resolution: null, ...patch,
  };
}
function fixture() {
  const files = new Map<string, Uint8Array>();
  const trace: string[] = [];
  let fail = "";
  let hold: Promise<void> | undefined;
  const fs: JournalFilesystem = {
    async initialize() { trace.push("initialize"); },
    async inventory() { return [...files].map(([name, bytes]) => ({ name, bytes: bytes.length })); },
    async read(name) { return files.get(name)?.slice() ?? null; },
    async write(name, bytes) { trace.push("write"); if (fail === "write") throw new Error("disk-full"); await hold; files.set(name, bytes.slice()); },
    async sync(name) { trace.push("sync"); if (fail === "sync") throw new Error("sync"); void name; },
    async replace(from, to) {
      trace.push("rename"); if (fail === "rename") throw new Error("rename");
      const bytes = files.get(from); if (!bytes) throw new Error("missing temp");
      files.set(to, bytes); files.delete(from);
    },
    async syncDirectory() { trace.push("directory-sync"); if (fail === "directory-sync") throw new Error("directory-sync"); },
    async remove(name) { files.delete(name); },
  };
  const profile = { hostEpoch: randomUUID(), assertHeld: vi.fn() };
  return { files, trace, fs, profile, fail: (value: string) => { fail = value; }, block: (value: Promise<void>) => { hold = value; } };
}
afterEach(() => vi.useRealTimers());
it("F10 strict documents reject replay fields, unknown versions and corruption", () => {
  const doc = journalDocument(1, [entry()]);
  expect(parseJournal(Buffer.from(JSON.stringify(doc)))).toEqual(doc);
  for (const invalid of [
    { ...doc, command: "run" }, { ...doc, schemaVersion: 2 },
    { ...doc, integrity: { algorithm: "sha256", digest: "0".repeat(64) } },
    { ...doc, entries: [{ ...doc.entries[0], power: 20 }] },
  ]) expect(() => parseJournal(Buffer.from(JSON.stringify(invalid)))).toThrow();
  expect(() => journalDocument(2, [entry({ providerId: "x".repeat(8193) })])).toThrow();
});
it("A-RF2 pending commits before risk; final failure keeps the durable blocker", async () => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  const marker = entry(), risk = vi.fn();
  await journal.commit(journalDocument(1, [marker])); risk();
  expect(m.trace.slice(-4)).toEqual(["write", "sync", "rename", "directory-sync"]);
  expect(risk).toHaveBeenCalledOnce(); m.fail("sync");
  await expect(journal.commit(journalDocument(2, [{ ...marker, revision: 2, state: "resolved",
    stopConfirmation: "confirmed", resolution: { kind: "confirmed-on-original-session", at: 2,
      sessionId: marker.sessionId, identityEvidence: "same-session" } }]))).rejects.toThrow();
  expect(journal.snapshot()).toMatchObject({ journalHealth: "unwritable", blockers: [marker.id] });
  expect(parseJournal(m.files.get("faults.json")!).entries[0]?.state).toBe("pending");
});
it.each(["write", "sync", "rename", "directory-sync"])("F10 pending %s failure sends no risk", async (point) => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load(); m.fail(point);
  const risk = vi.fn();
  await expect(journal.commit(journalDocument(1, [entry()])).then(risk)).rejects.toThrow();
  expect(risk).not.toHaveBeenCalled(); expect(journal.snapshot().journalHealth).toBe("unwritable");
});
it("F10 accepts 64 entries and refuses the 65th without evicting unresolved evidence", async () => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  const entries = Array.from({ length: 64 }, () => entry());
  await journal.commit(journalDocument(1, entries));
  expect(() => journalDocument(2, [...entries, entry()])).toThrow();
  expect(journal.snapshot().faults).toHaveLength(64);
  expect(journal.snapshot().journalHealth).toBe("full");
});
it("F10 reserves replacement bytes inside 8 MiB, preserving existing evidence", async () => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  m.files.set("evidence.bin", new Uint8Array(8 * 1024 * 1024));
  await expect(journal.commit(journalDocument(1, [entry()]))).rejects.toThrow();
  expect(m.trace).not.toContain("write"); expect(m.files.get("evidence.bin")?.length).toBe(8388608);
});
it("F10 a 5-second timeout fences later commits and late risk dispatch", async () => {
  vi.useFakeTimers(); const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  let release!: () => void; m.block(new Promise<void>((resolve) => { release = resolve; }));
  const risk = vi.fn(); const pending = journal.commit(journalDocument(1, [entry()])).then(risk);
  const rejected = expect(pending).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(5000); await rejected;
  await expect(journal.commit(journalDocument(2, [entry()]))).rejects.toThrow();
  release(); await vi.runAllTimersAsync();
  expect(risk).not.toHaveBeenCalled(); expect(journal.snapshot().journalHealth).toBe("unwritable");
  expect([...m.files.keys()].filter((name) => /faults\.(next|backup)-/.test(name))).toEqual([]);
  expect(m.trace.at(-1)).toBe("directory-sync");
});
it("F11 restart projects pending and active-program as unknown without I/O replay", async () => {
  const m = fixture(); m.files.set("faults.json", Buffer.from(JSON.stringify(journalDocument(1, [entry({ state: "active-program", dispatch: "sent" })]))));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  expect(journal.snapshot().faults[0]).toMatchObject({ state: "unconfirmed", movement: "unknown", cause: "host-restarted" });
  expect(m.trace).toEqual(["initialize"]);
});
it.each(["missing", "corrupt", "future"])("F10 current %s preserves previous pending evidence", async (kind) => {
  const m = fixture(), marker = entry();
  m.files.set("faults.previous.json", Buffer.from(JSON.stringify(journalDocument(1, [marker]))));
  if (kind !== "missing") m.files.set("faults.json", Buffer.from(kind === "corrupt" ? "{" : '{"schemaVersion":2}'));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  expect(journal.snapshot().journalHealth).toBe("corrupt"); expect(journal.snapshot().blockers).toContain(marker.id);
  await expect(journal.commit(journalDocument(2, []))).rejects.toThrow();
});
it("F20 secondary initialization performs no filesystem work", () => {
  const m = fixture(); m.profile.assertHeld.mockImplementation(() => { throw new Error("secondary"); });
  expect(() => createJournal(m.fs, m.profile)).toThrow("secondary"); expect(m.trace).toEqual([]);
});
it.each(["write", "sync", "rename", "directory-sync"])("F10 final %s failure cannot erase the original in-memory blocker", async (point) => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  const marker = entry(); await journal.commit(journalDocument(1, [marker])); m.fail(point);
  await expect(journal.commit(journalDocument(2, [{ ...marker, revision: 2, state: "resolved", stopConfirmation: "confirmed", resolution: { kind: "confirmed-on-original-session", at: 2, sessionId: marker.sessionId, identityEvidence: "same-session" } }]))).rejects.toThrow();
  expect(journal.snapshot()).toMatchObject({ journalHealth: "unwritable", blockers: [marker.id] });
});
it("F11 restart snapshots cannot mutate the retained physical evidence", async () => {
  const m = fixture(), marker = entry(); m.files.set("faults.json", Buffer.from(JSON.stringify(journalDocument(1, [marker]))));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  journal.snapshot().faults[0]!.physical.digest = "b".repeat(64);
  expect((await journal.load()).entries[0]!.physical.digest).toBe(marker.physical.digest);
});

function resolved(marker: SafetyFaultEntry): SafetyFaultEntry {
  return { ...marker, revision: marker.revision + 1, state: "resolved", stopConfirmation: "confirmed",
    resolution: { kind: "observed-idle", at: 2, sessionId: marker.sessionId, identityEvidence: "serial-match" } };
}
it("restart keeps each remaining fault projected and persists unknown movement on resolution", async () => {
  const m = fixture(), a = entry(), b = entry();
  m.files.set("faults.json", Buffer.from(JSON.stringify(journalDocument(1, [a, b]))));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  await journal.commit(journalDocument(2, [resolved(a), b]));
  expect(journal.snapshot().faults[1]).toMatchObject({ state: "unconfirmed", movement: "unknown", cause: "host-restarted" });
  expect(parseJournal(m.files.get("faults.json")!).entries[0]?.movement).toBe("unknown");
});
it.each([true, false])("interrupted temp sync permits resolution repair with current=%s", async (hasCurrent) => {
  const m = fixture(), a = entry(), b = entry();
  if (hasCurrent) m.files.set("faults.json", Buffer.from(JSON.stringify(journalDocument(1, [a]))));
  const orphan = `faults.next-${randomUUID()}.json`;
  m.files.set(orphan, Buffer.from(JSON.stringify(journalDocument(2, [a, b]))));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  expect(journal.snapshot()).toMatchObject({ journalHealth: "corrupt", blockers: [a.id, b.id] });
  await journal.commit(journalDocument(3, [resolved(a), b]));
  expect(m.files.has(orphan)).toBe(false);
  expect(journal.snapshot().journalHealth).toBe("ready");
  expect(parseJournal(m.files.get("faults.json")!).entries).toHaveLength(2);
  expect(journal.snapshot().faults[1]?.movement).toBe("unknown");
});
it.each(["physical", "merged"])("load %s budget retains 64 unresolved blockers", async (budget) => {
  const m = fixture(), entries = Array.from({ length: 64 }, () => entry());
  m.files.set(`faults.next-${randomUUID()}.json`, Buffer.from(JSON.stringify(journalDocument(1, entries))));
  if (budget === "physical") m.files.set("evidence.bin", new Uint8Array(8388608));
  else m.files.set(`faults.next-${randomUUID()}.json`, Buffer.from(JSON.stringify(journalDocument(2, [entry()]))));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  expect(journal.snapshot().journalHealth).toBe("corrupt");
  expect(journal.snapshot().blockers).toEqual(entries.map((item) => item.id));
});
it("commit rejects unresolved eviction even when the replacement has 64 entries", async () => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  const entries = Array.from({ length: 64 }, () => entry());
  await journal.commit(journalDocument(1, entries));
  await expect(journal.commit(journalDocument(2, [...entries.slice(1), entry()]))).rejects.toThrow("journal unresolved eviction");
  expect(journal.snapshot().blockers).toEqual(entries.map((item) => item.id));
});
it("pending admission rejects the 65th queued commit without writing it", async () => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  let release!: () => void; m.block(new Promise<void>((resolve) => { release = resolve; }));
  const marker = entry();
  const queued = Array.from({ length: 64 }, (_, i) => journal.commit(journalDocument(i + 1, [marker])));
  await expect(journal.commit(journalDocument(65, [marker]))).rejects.toThrow("journal write blocked");
  release(); await Promise.all(queued);
  expect(journal.snapshot().revision).toBe(64);
});
it.each(["sync", "rename", "directory-sync"])("failed %s commit cleans its temporary artifacts", async (point) => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  await journal.commit(journalDocument(1, [entry()])); m.fail(point);
  await expect(journal.commit(journalDocument(2, journal.snapshot().faults))).rejects.toThrow(point);
  expect([...m.files.keys()].filter((name) => /faults\.(next|backup)-/.test(name))).toEqual([]);
  expect(m.trace.at(-1)).toBe("directory-sync");
});
it.each(["new-entry", "changed-evidence"])("repair refuses %s while risk remains blocked", async (change) => {
  const m = fixture(), marker = entry();
  m.files.set(`faults.backup-${randomUUID()}.json`, Buffer.from(JSON.stringify(journalDocument(1, [marker]))));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  const entries = change === "new-entry" ? [marker, entry()] : [{ ...marker, revision: 2, dispatch: "sent" as const }];
  await expect(journal.commit(journalDocument(2, entries))).rejects.toThrow("journal repair only");
  expect(journal.snapshot().blockers).toEqual([marker.id]);
});
it.each(["corrupt-current", "newer-previous"])("orphan does not make %s repairable", async (kind) => {
  const m = fixture(), marker = entry();
  m.files.set("faults.json", kind === "corrupt-current" ? Buffer.from("{") : Buffer.from(JSON.stringify(journalDocument(1, [marker]))));
  m.files.set("faults.previous.json", Buffer.from(JSON.stringify(journalDocument(2, [marker]))));
  m.files.set(`faults.next-${randomUUID()}.json`, Buffer.from(JSON.stringify(journalDocument(3, [marker]))));
  const journal = createJournal(m.fs, m.profile); await journal.load();
  await expect(journal.commit(journalDocument(4, [resolved(marker)]))).rejects.toThrow("journal write blocked");
  expect(journal.snapshot()).toMatchObject({ journalHealth: "corrupt", blockers: [marker.id] });
});
it("cleanup failures preserve the original commit error and still sync the directory", async () => {
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  m.fail("sync"); m.fs.remove = async () => { throw new Error("cleanup-error"); };
  await expect(journal.commit(journalDocument(1, [entry()]))).rejects.toThrow(/^sync$/);
  expect(m.trace.at(-1)).toBe("directory-sync");
});
it("deadline cleans already-created temp and backup while backup sync is stalled", async () => {
  vi.useFakeTimers();
  const m = fixture(), journal = createJournal(m.fs, m.profile); await journal.load();
  const marker = entry(); await journal.commit(journalDocument(1, [marker]));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  m.fs.sync = async (name) => { if (name.startsWith("faults.backup-")) await held; };
  const pending = journal.commit(journalDocument(2, [marker]));
  const rejected = expect(pending).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect([...m.files.keys()].filter((name) => /faults\.(next|backup)-/.test(name))).toEqual([]);
  release(); await vi.runAllTimersAsync();
  expect(parseJournal(m.files.get("faults.json")!).revision).toBe(1);
});
