import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { namespacedIdSchema } from "@kobrixa/plugin-protocol";
import { sourceKeySchema } from "@kobrixa/plugin-runtime";
import type { FaultJournalDocument, SafetyFaultEntry, ProfileWriterLock } from "@kobrixa/plugin-runtime";
import type { JournalPort, DeviceRecoverySnapshot } from "./journal-port.js";
import type { JournalFilesystem } from "./journal-filesystem.js";
const handle = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const resourceOwner = z.strictObject({ sourceKey: sourceKeySchema, pluginId: namespacedIdSchema, generation: counter, hostEpoch: handle, processEpoch: handle });
const owner = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plugin"), owner: resourceOwner }),
  z.strictObject({ kind: z.literal("core"), adapter: z.enum(["deployment", "program", "remote-files", "monitor", "battery", "motor", "lab", "recovery"]), hostEpoch: handle, workbenchInstance: handle }),
]);
const reasons = ["provider-disabled", "disconnected", "quarantined", "ui-scope-unavailable", "unsupported-capability", "foreground", "recording", "connecting", "source-changing", "unbound", "joining", "unsynced", "not-holder", "viewer", "authority-changed", "scope-expired", "preflight-program-running", "preflight-output-unknown", "preflight-output-moving", "motor-unavailable", "source-changed", "mode-unavailable", "provider-failure", "provider-contract", "journal-unwritable", "journal-corrupt", "identity-ambiguous", "readback-failed", "stop-deadline", "connection-lost", "provider-stalled", "deadline", "cancelled", "disabled", "safe-mode", "shutting-down", "process-lost", "protocol", "provider-conflict", "none", "host-restarted"] as const;
const fault = z.strictObject({
  id: handle, revision: counter, owner, providerId: namespacedIdSchema, providerGeneration: counter,
  physical: z.strictObject({ providerId: namespacedIdSchema, family: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/), basis: z.enum(["serial", "endpoint", "unknown"]), digest: digest.nullable(), strength: z.enum(["stable", "session-only"]) }),
  sessionId: handle, operationId: handle, operationClass: z.enum(["finite-motion", "program-launch", "safety-stop"]),
  createdAt: counter, updatedAt: counter, state: z.enum(["pending", "active-program", "unconfirmed", "resolved"]),
  dispatch: z.enum(["not-sent", "sent", "unknown"]), movement: z.enum(["not-started", "completed", "interrupted", "timed-out", "unknown"]),
  stopRequested: z.boolean(), stopConfirmation: z.enum(["not-required", "pending", "confirmed", "unconfirmed"]), cause: z.enum(reasons),
  resolution: z.strictObject({ kind: z.enum(["not-issued", "confirmed-on-original-session", "observed-idle"]), at: counter, sessionId: handle, identityEvidence: z.enum(["same-session", "serial-match", "user-confirmed-device"]) }).nullable(),
});
const documentSchema = z.strictObject({ schemaVersion: z.literal(1), revision: counter, entries: z.array(fault).max(64), integrity: z.strictObject({ algorithm: z.literal("sha256"), digest }) });
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new Error("journal non-JSON value");
}
function checksum(document: Pick<FaultJournalDocument, "schemaVersion" | "revision" | "entries">): string {
  return createHash("sha256").update(canonical(document), "utf8").digest("hex");
}
export function journalDocument(revision: number, entries: SafetyFaultEntry[]): FaultJournalDocument {
  const body = { schemaVersion: 1 as const, revision, entries };
  const result = { ...body, integrity: { algorithm: "sha256" as const, digest: checksum(body) } };
  return parseJournal(Buffer.from(canonical(result)));
}
export function parseJournal(bytes: Uint8Array): FaultJournalDocument {
  if (bytes.length > 8388608) throw new Error("journal byte limit");
  const parsed = documentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const ids = new Set<string>();
  for (const item of parsed.entries) {
    if (ids.has(item.id) || Buffer.byteLength(canonical(item)) > 8192) throw new Error("journal entry limit"); ids.add(item.id);
    if (item.physical.providerId !== item.providerId || item.updatedAt < item.createdAt) throw new Error("journal identity");
    if ((item.physical.basis === "unknown") !== (item.physical.digest === null)) throw new Error("journal digest basis");
    if (item.physical.strength === "stable" && item.physical.basis !== "serial") throw new Error("journal weak identity");
    if ((item.state === "resolved") !== (item.resolution !== null)) throw new Error("journal resolution");
  }
  if (checksum({ schemaVersion: 1, revision: parsed.revision, entries: parsed.entries }) !== parsed.integrity.digest) throw new Error("journal integrity");
  return parsed;
}
export function createJournal(fs: JournalFilesystem, profile: ProfileWriterLock): JournalPort {
  profile.assertHeld();
  let committed = journalDocument(0, []), loaded = false, blocked = false;
  let health: DeviceRecoverySnapshot["journalHealth"] = "ready";
  // The frozen public health union reports repairable intents as corrupt, blocking risk.
  let recovering = false, pending = 0, tail: Promise<void> = Promise.resolve();
  const carried = new Set<string>(), orphans = new Set<string>();
  const project = (item: SafetyFaultEntry): SafetyFaultEntry => carried.has(item.id) && item.state !== "resolved"
    ? { ...item, state: "unconfirmed", movement: "unknown", stopConfirmation: "unconfirmed", cause: "host-restarted" } : item;
  const listeners = new Set<(snapshot: DeviceRecoverySnapshot) => void>();
  const snapshot = (): DeviceRecoverySnapshot => {
    const faults = committed.entries.map((item) => project(structuredClone(item)));
    return { revision: committed.revision, journalHealth: health === "ready" && faults.length === 64 && faults.every((item) => item.state !== "resolved") ? "full" : health,
      faults, blockers: faults.filter((item) => item.state !== "resolved").map((item) => item.id) };
  };
  const emit = (): void => { for (const listener of listeners) { try { listener(snapshot()); } catch { /* Subscriber failure cannot clear evidence. */ } } };
  return {
    async load() {
      profile.assertHeld(); if (loaded) return structuredClone(committed);
      const found: FaultJournalDocument[] = [];
      try {
        try { await fs.initialize(); } catch { health = "unwritable"; throw new Error("journal initialization"); }
        const files = await fs.inventory();
        const overBudget = files.reduce((n, file) => n + file.bytes, 0) > 8388608;
        // Still read valid documents so a budget violation cannot hide their blockers.
        if (overBudget) health = "corrupt";
        const committedDocuments: FaultJournalDocument[] = [];
        let current: FaultJournalDocument | undefined;
        for (const file of files) {
          if (!/^faults(?:\.previous|\.(?:next|backup)-[0-9a-f-]{36})?\.json$/.test(file.name)) { health = "corrupt"; continue; }
          try {
            const bytes = await fs.read(file.name); if (!bytes) throw new Error("journal missing file");
            const doc = parseJournal(bytes); found.push(doc);
            if (/^faults\.(next|backup)-/.test(file.name)) orphans.add(file.name);
            else committedDocuments.push(doc);
            if (file.name === "faults.json") current = doc;
          } catch { health = "corrupt"; }
        }
        if (files.length && !current && !orphans.size) health = "corrupt";
        if (current) committed = current;
        const newer = committedDocuments.filter((doc) => doc.revision > committed.revision);
        if (newer.length) health = "corrupt";
        recovering = orphans.size > 0 && health === "ready";
        if (orphans.size || health === "corrupt") {
          health = "corrupt";
          const evidence = new Map<string, SafetyFaultEntry>(committed.entries.map((item) => [item.id, item]));
          for (const doc of found) for (const item of doc.entries) {
            const old = evidence.get(item.id);
            if (item.state !== "resolved" && (!old || old.state === "resolved" || item.revision > old.revision)) evidence.set(item.id, item);
          }
          const entries = [...evidence.values()];
          const retained = entries.length > 64 ? [...entries.filter((item) => item.state !== "resolved"), ...entries.filter((item) => item.state === "resolved")].slice(0, 64) : entries;
          committed = journalDocument(Math.max(committed.revision, ...found.map((doc) => doc.revision)), retained);
          if (entries.length > 64) throw new Error("journal evidence exceeds display bound");
        }
      } catch { recovering = false; if (health !== "unwritable") health = "corrupt"; }
      for (const item of committed.entries) if (item.state !== "resolved") carried.add(item.id);
      loaded = true; blocked = health !== "ready" && !recovering; emit(); return structuredClone(committed);
    },
    commit(input) {
      profile.assertHeld();
      if (!loaded || blocked || pending >= 64) return Promise.reject(new Error("journal write blocked"));
      let next = parseJournal(Buffer.from(canonical(input))); pending++;
      let expired = false;
      const created = new Set<string>();
      const cleanup = async (): Promise<void> => {
        for (const name of created) { try { await fs.remove(name); } catch { /* Preserve the original failure. */ } }
        try { await fs.syncDirectory(); } catch { /* Preserve the original failure. */ }
      };
      const task = tail.then(async () => {
        profile.assertHeld(); if (blocked || expired) throw new Error("journal write blocked");
        next = journalDocument(next.revision, next.entries.map((item) => carried.has(item.id)
          ? item.state === "resolved" ? { ...item, movement: "unknown" as const, cause: "host-restarted" as const } : project(item) : item));
        if (recovering) {
          for (const item of next.entries) {
            const old = committed.entries.find((entry) => entry.id === item.id);
            if (!old) throw new Error("journal repair only");
            const before = project(old);
            const allowed = item.state === "resolved" && old.state !== "resolved"
              ? { ...before, revision: item.revision, updatedAt: item.updatedAt, state: item.state,
                  stopConfirmation: item.stopConfirmation, resolution: item.resolution } : before;
            if (canonical(item) !== canonical(allowed)) throw new Error("journal repair only");
          }
        }
        if (next.revision !== committed.revision + 1) throw new Error("journal stale revision");
        for (const old of committed.entries) {
          const item = next.entries.find((entry) => entry.id === old.id);
          if (old.state !== "resolved" && !item) throw new Error("journal unresolved eviction");
          if (item && (item.revision < old.revision || (item.revision === old.revision && canonical(item) !== canonical(project(old))))) throw new Error("journal entry revision");
        }
        const bytes = Buffer.from(canonical(next)), previous = Buffer.from(canonical(committed));
        const inventory = await fs.inventory();
        if (inventory.reduce((n, file) => n + file.bytes, 0) + bytes.length + previous.length > 8388608) throw new Error("journal replacement quota");
        const temporary = `faults.next-${randomUUID()}.json`;
        created.add(temporary);
        await fs.write(temporary, bytes); await fs.sync(temporary);
        if (committed.revision > 0) {
          const backup = `faults.backup-${randomUUID()}.json`;
          created.add(backup);
          await fs.write(backup, previous); await fs.sync(backup);
          profile.assertHeld(); if (expired) throw new Error("journal deadline");
          await fs.replace(backup, "faults.previous.json"); await fs.syncDirectory();
        }
        profile.assertHeld(); if (expired) throw new Error("journal deadline");
        await fs.replace(temporary, "faults.json"); await fs.syncDirectory();
        if (expired) throw new Error("journal deadline");
        if (recovering) {
          for (const name of orphans) await fs.remove(name);
          await fs.syncDirectory();
        }
        if (expired) throw new Error("journal deadline");
        committed = next; recovering = false; orphans.clear(); health = "ready";
        for (const item of next.entries) if (item.state === "resolved") carried.delete(item.id);
        emit();
      }).catch(async (error: unknown) => { blocked = true; health = "unwritable"; emit(); await cleanup(); throw error; }).finally(() => { pending--; });
      tail = task.catch(() => {});
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { expired = true; blocked = true; health = "unwritable"; emit(); void cleanup(); reject(new Error("journal deadline")); }, 5000);
        task.then(() => { clearTimeout(timer); if (!expired) resolve(); }, (error: unknown) => { clearTimeout(timer); reject(error); });
      });
    },
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
