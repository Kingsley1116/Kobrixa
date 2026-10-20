import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Handle, ResourceOwner } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { DeviceAuthorityReport } from "../../shared/collab.js";
import type { AuthorityContextRecord, AuthorityPort } from "./authority-port.js";

const handle = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const authorityReportSchema = z.strictObject({
  document: handle,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["local", "joining", "room", "unsynced", "invalid"]),
  roomId: z.string().min(1).max(160).nullable(),
  connected: z.boolean(), synced: z.boolean(),
  role: z.enum(["host", "editor", "viewer"]).nullable(), isHolder: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.state === "local" && (value.roomId !== null || value.role !== null ||
      !value.connected || !value.synced || !value.isHolder))
    ctx.addIssue({ code: "custom", message: "Local authority must be explicit." });
  if ((value.state === "room" || value.state === "joining" || value.state === "unsynced") &&
      (value.roomId === null || value.role === null))
    ctx.addIssue({ code: "custom", message: "Room identity is required." });
});

type CoreAdapter = Extract<Principal, { kind: "core" }>["adapter"];
type Entry = { document: Handle; record: AuthorityContextRecord; sequence: number;
  reportKey: string; roomId: string | null; owners: Set<string> };
const ownerKey = (o: ResourceOwner) => JSON.stringify([
  o.sourceKey, o.pluginId, o.generation, o.hostEpoch, o.processEpoch,
]);
export class AuthorityDenied extends Error {
  readonly code = "PLUGIN_E_DEVICE_AUTHORITY";
  readonly detail;
  constructor(reason: "unbound" | "joining" | "unsynced" | "viewer" | "not-holder" | "authority-changed") {
    super(reason);
    this.detail = { kind: "device" as const, reason, dispatch: "not-sent" as const,
      stopConfirmation: "not-required" as const };
  }
}
export class AuthorityContexts implements AuthorityPort {
  readonly #entries = new Map<number, Entry>();
  readonly #listeners = new Set<(ref: Handle, epoch: Handle) => void>();
  constructor(readonly hostEpoch: Handle, private readonly uuid: () => Handle = randomUUID) {}

  open(sender: number): Handle {
    const current = this.#entries.get(sender);
    if (current) return current.document;
    const record: AuthorityContextRecord = {
      ref: this.uuid(), epoch: this.uuid(), workbenchInstance: this.uuid(),
      state: "invalid", roomBinding: null, connected: false, synced: false,
      role: null, isHolder: false,
    };
    const entry: Entry = { document: this.uuid(), record, sequence: 0,
      reportKey: "", roomId: null, owners: new Set() };
    this.#entries.set(sender, entry);
    return entry.document;
  }
  report(sender: number, input: unknown): void {
    const report: DeviceAuthorityReport = authorityReportSchema.parse(input);
    const entry = this.#entries.get(sender);
    if (!entry || entry.document !== report.document) throw new Error("Stale authority document.");
    if (report.sequence <= entry.sequence) return;
    entry.sequence = report.sequence;
    const key = JSON.stringify([report.state, report.roomId, report.connected,
      report.synced, report.role, report.isHolder]);
    if (key === entry.reportKey) return;
    entry.reportKey = key;
    const roomBinding = report.roomId === null ? null :
      entry.roomId === report.roomId && entry.record.roomBinding !== null
        ? entry.record.roomBinding : this.uuid();
    entry.roomId = report.roomId;
    entry.record = Object.freeze({ ...entry.record, epoch: this.uuid(), roomBinding,
      state: report.state, connected: report.connected, synced: report.synced,
      role: report.role, isHolder: report.isHolder });
    this.#emit(entry.record);
  }
  core(sender: number, adapter: CoreAdapter): Extract<Principal, { kind: "core" }> {
    const entry = this.#entries.get(sender);
    if (!entry) throw new AuthorityDenied("unbound");
    return Object.freeze({ kind: "core", adapter, hostEpoch: this.hostEpoch,
      workbenchInstance: entry.record.workbenchInstance,
      authorityContext: Object.freeze({ ref: entry.record.ref, epoch: entry.record.epoch }) });
  }
  plugin(sender: number, owner: ResourceOwner): Extract<Principal, { kind: "plugin" }> {
    const entry = this.#entries.get(sender);
    if (!entry || owner.hostEpoch !== this.hostEpoch) throw new AuthorityDenied("unbound");
    entry.owners.add(ownerKey(owner));
    return Object.freeze({ kind: "plugin", owner: Object.freeze({ ...owner }),
      authorityContext: Object.freeze({ ref: entry.record.ref, epoch: entry.record.epoch }) });
  }
  unbind(owner: ResourceOwner): void {
    for (const entry of this.#entries.values()) entry.owners.delete(ownerKey(owner));
  }
  invalidate(sender: number): void {
    const entry = this.#entries.get(sender);
    if (!entry) return;
    this.#entries.delete(sender);
    this.#emit({ ...entry.record, epoch: this.uuid(), state: "invalid", isHolder: false });
  }
  current(principal: Principal, contextRef: Handle): AuthorityContextRecord | null {
    const binding = principal.authorityContext;
    if (!binding || binding.ref !== contextRef) return null;
    for (const entry of this.#entries.values()) {
      const record = entry.record;
      if (record.ref !== contextRef || record.epoch !== binding.epoch) continue;
      if (principal.kind === "core") {
        if (principal.hostEpoch !== this.hostEpoch ||
            principal.workbenchInstance !== record.workbenchInstance) return null;
      } else if (!entry.owners.has(ownerKey(principal.owner))) return null;
      return { ...record };
    }
    return null;
  }
  assertContinuation(principal: Principal, contextRef: Handle): void {
    if (!principal.authorityContext) throw new AuthorityDenied("unbound");
    const current = this.current(principal, contextRef);
    if (!current) throw new AuthorityDenied("authority-changed");
    if (current.state === "invalid") throw new AuthorityDenied("unbound");
    if (current.state === "joining") throw new AuthorityDenied("joining");
    if (current.state === "unsynced" || !current.connected || !current.synced)
      throw new AuthorityDenied("unsynced");
    if (current.state === "local") return;
    if (current.role === "viewer") throw new AuthorityDenied("viewer");
    if (!current.isHolder) throw new AuthorityDenied("not-holder");
  }
  subscribe(listener: (ref: Handle, epoch: Handle) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #emit(record: AuthorityContextRecord): void {
    for (const listener of [...this.#listeners]) listener(record.ref, record.epoch);
  }
}
