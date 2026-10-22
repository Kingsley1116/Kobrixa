import { randomUUID } from "node:crypto";
import type {
  BusinessResult,
  DeviceFailureDetail,
  ResourceKind,
  ResourceOwner,
  DeviceListValue,
} from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { BuiltinDeviceProvider, ProviderCatalogPort } from "./provider.js";
export class BrokerFailure extends Error {
  constructor(readonly result: Extract<BusinessResult<never, DeviceFailureDetail>, { ok: false }>) {
    super(result.error.message);
  }
}
export const stale = (resource: ResourceKind = "operation"): never => {
  throw new BrokerFailure({
    ok: false,
    error: {
      code: "PLUGIN_E_STALE_RESOURCE",
      message: "Resource is unavailable.",
      detail: { kind: "resource", reason: "stale", resource },
    },
  });
};
export const quota = (resource: ResourceKind, limit: number): never => {
  throw new BrokerFailure({
    ok: false,
    error: {
      code: "PLUGIN_E_RESOURCE_LIMIT",
      message: "Resource limit reached.",
      detail: { kind: "resource", reason: "quota", resource, limit },
    },
  });
};
export const deviceFailure = (
  code: Extract<BusinessResult<never, DeviceFailureDetail>, { ok: false }>["error"]["code"],
  reason: Extract<DeviceFailureDetail, { kind: "device" }>["reason"],
  dispatch: "not-sent" | "sent" | "unknown" = "not-sent",
): never => {
  throw new BrokerFailure({
    ok: false,
    error: {
      code,
      message: "Device operation unavailable.",
      detail: {
        kind: "device",
        reason,
        dispatch,
        stopConfirmation: dispatch === "not-sent" ? "not-required" : "unconfirmed",
      },
    },
  });
};
export const resourceOwnerKey = (o: ResourceOwner): string =>
  JSON.stringify([o.sourceKey, o.pluginId, o.generation, o.hostEpoch, o.processEpoch]);
export const ownerKey = (p: Principal): string =>
  p.kind === "plugin"
    ? resourceOwnerKey(p.owner)
    : JSON.stringify(["core", p.adapter, p.hostEpoch, p.workbenchInstance]);
export class OwnerLedger<T> {
  readonly rows = new Map<string, { owner: string; value: T }>();
  constructor(
    private readonly sourceLimit: number,
    private readonly hostLimit: number,
    private readonly resource: ResourceKind,
  ) {}
  add(owner: string, value: T): string {
    if (this.rows.size >= this.hostLimit) quota(this.resource, this.hostLimit);
    if ([...this.rows.values()].filter((r) => r.owner === owner).length >= this.sourceLimit)
      quota(this.resource, this.sourceLimit);
    const id = randomUUID();
    this.rows.set(id, { owner, value });
    return id;
  }
  get(owner: string, id: string): T {
    const row = this.rows.get(id);
    if (!row || row.owner !== owner) return stale(this.resource);
    return row.value;
  }
  remove(id: string): void {
    this.rows.delete(id);
  }
}
export class ProviderRegistry {
  #generation = 0;
  #claims = new Map<string, Set<string>>();
  readonly records = new Map<
    string,
    Array<{ provider: BuiltinDeviceProvider; generation: number; conflict: boolean }>
  >();
  add(provider: BuiltinDeviceProvider): () => void {
    if (!this.records.has(provider.id) && this.records.size >= 8) quota("candidate", 8);
    const rows = this.records.get(provider.id) ?? [];
    const row = { provider, generation: ++this.#generation, conflict: rows.length > 0 };
    if (rows.length) for (const previous of rows) previous.conflict = true;
    rows.push(row);
    this.records.set(provider.id, rows);
    return () => {
      const current = this.records.get(provider.id);
      if (!current) return;
      const index = current.indexOf(row);
      if (index >= 0) current.splice(index, 1);
      if (!current.length) this.records.delete(provider.id);
    };
  }
  claim(id: string, identity: { family: string; basis: string; digest: string | null }): void {
    if (identity.digest === null) return;
    const key = JSON.stringify([identity.family, identity.basis, identity.digest]);
    const claims = this.#claims.get(key) ?? new Set<string>();
    claims.add(id);
    this.#claims.set(key, claims);
    if (claims.size > 1) for (const claimant of claims) this.conflict(claimant);
  }
  conflict(id: string): void {
    for (const row of this.records.get(id) ?? []) row.conflict = true;
  }
  get(id: string) {
    const rows = this.records.get(id);
    if (!rows?.length) return deviceFailure("PLUGIN_E_DEVICE_UNAVAILABLE", "provider-disabled");
    if (rows.length !== 1 || rows[0]!.conflict)
      return deviceFailure("PLUGIN_E_PROVIDER_CONFLICT", "provider-conflict");
    return rows[0]!;
  }
  list(): DeviceListValue["providers"] {
    return [...this.records].map(([providerId, rows]) => ({
      providerId,
      state: rows.length === 1 && !rows[0]!.conflict ? "available" : "conflict",
      capabilities: [...rows[0]!.provider.capabilities],
    }));
  }
}
export function createProviderCatalog(): ProviderCatalogPort {
  const handles = new Map<string, string>();
  return {
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
    identify(input) {
      const key = JSON.stringify([
        input.sessionId,
        input.portId,
        input.typeId,
        input.modeId,
        input.component,
        input.unit,
      ]);
      let id = handles.get(key);
      if (!id) {
        id = randomUUID();
        handles.set(key, id);
      }
      return id;
    },
  };
}

import type {
  CommonEventLedgerPort,
  Stage3Event,
  Stage3EventEnvelope,
} from "@kobrixa/plugin-runtime";
import type {
  ResourceErrorDetail,
  Stage3PluginErrorCode,
  PluginErrorCodeV150,
  Counter,
  Handle,
} from "@kobrixa/plugin-protocol";
import { RpcError, RPC_ERRORS } from "@kobrixa/plugin-protocol";
type EventRow = {
  owner: ResourceOwner;
  sequence: number;
  sent: number;
  ack: number;
  active: boolean;
  terminal: boolean;
  removed: boolean;
  telemetryGap?: { fromSequence: number; toSequence: number; reason: "overflow" };
  pending: Array<{ event: Stage3EventEnvelope; at: number; bytes: number }>;
};
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const eventSuccess = <T>(value: T): BusinessResult<T, ResourceErrorDetail> => ({ ok: true, value });
export class EventLedger implements CommonEventLedgerPort {
  #rows = new Map<Handle, EventRow>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #schedule() {
    if (!this.#timer) {
      this.#timer = setInterval(() => this.sweep(), 500);
      this.#timer.unref();
    }
  }
  dispose() {
    for (const [id, row] of this.#rows) this.unsubscribe(row.owner, id);
    this.#rows.clear();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
  #removed = new Set<(id: Handle) => void>();
  constructor(
    private readonly now: () => number,
    private readonly send: (event: Stage3EventEnvelope) => void,
    private readonly revoke: (owner: ResourceOwner) => void,
  ) {}
  #row(owner: ResourceOwner, id: Handle): EventRow {
    const row = this.#rows.get(id);
    if (!row || resourceOwnerKey(row.owner) !== resourceOwnerKey(owner))
      return stale("subscription");
    return row;
  }
  create(owner: ResourceOwner) {
    const active = [...this.#rows.values()].filter((row) => !row.removed);
    if (
      active.length >= 256 ||
      active.filter((row) => row.owner.sourceKey === owner.sourceKey).length >= 32
    )
      return {
        ok: false as const,
        error: {
          code: "PLUGIN_E_RESOURCE_LIMIT" as const,
          message: "Subscription limit",
          detail: {
            kind: "resource" as const,
            reason: "quota" as const,
            resource: "subscription" as const,
            limit: active.length >= 256 ? 256 : 32,
          },
        },
      };
    const subscriptionId = randomUUID();
    this.#rows.set(subscriptionId, {
      owner: structuredClone(owner),
      sequence: 0,
      sent: 0,
      ack: 0,
      active: false,
      terminal: false,
      removed: false,
      pending: [],
    });
    this.#schedule();
    return eventSuccess({ subscriptionId, sequence: 0 as const });
  }
  owns(owner: ResourceOwner, id: Handle) {
    const row = this.#rows.get(id);
    return !!row && !row.removed && resourceOwnerKey(row.owner) === resourceOwnerKey(owner);
  }
  #send(row: EventRow, event: Stage3EventEnvelope) {
    row.sent = Math.max(row.sent, event.sequence);
    try {
      this.send(event);
    } catch (error) {
      if (!row.removed) this.unsubscribe(row.owner, event.subscriptionId);
      throw error;
    }
  }
  activate(owner: ResourceOwner, id: Handle) {
    const row = this.#row(owner, id);
    if (row.removed || row.active) return;
    row.active = true;
    for (const item of [...row.pending]) if (!row.removed) this.#send(row, item.event);
  }
  publish(owner: ResourceOwner, id: Handle, event: Stage3Event, delivery: "control" | "telemetry") {
    const row = this.#row(owner, id);
    if (row.removed || row.terminal) return stale("subscription");
    if (delivery === "telemetry" && row.telemetryGap) {
      if (event.kind === "devices.telemetry") {
        event = {
          ...event,
          data: {
            ...event.data,
            frames: event.data.frames.map((frame, index) =>
              index === 0
                ? {
                    ...frame,
                    gap: {
                      fromSequence: Math.min(
                        row.telemetryGap!.fromSequence,
                        frame.gap?.fromSequence ?? row.telemetryGap!.fromSequence,
                      ),
                      toSequence: Math.max(
                        row.telemetryGap!.toSequence,
                        frame.gap?.toSequence ?? row.telemetryGap!.toSequence,
                      ),
                      reason: frame.gap?.reason ?? row.telemetryGap!.reason,
                    },
                  }
                : frame,
            ),
          },
        };
      } else if (event.kind === "devices.recordingFrames") {
        event = {
          ...event,
          data: {
            ...event.data,
            frames: event.data.frames.map((frame, index) =>
              index === 0
                ? {
                    ...frame,
                    gap: {
                      fromSequence: Math.min(
                        row.telemetryGap!.fromSequence,
                        frame.gap?.fromSequence ?? row.telemetryGap!.fromSequence,
                      ),
                      toSequence: Math.max(
                        row.telemetryGap!.toSequence,
                        frame.gap?.toSequence ?? row.telemetryGap!.toSequence,
                      ),
                      reason: frame.gap?.reason ?? row.telemetryGap!.reason,
                    },
                  }
                : frame,
            ),
          },
        };
      }
    }
    const envelope: Stage3EventEnvelope = {
      version: 1,
      subscriptionId: id,
      owner: row.owner,
      sequence: row.sequence + 1,
      delivery,
      ...event,
    };
    const bytes = encodedBytes(envelope);
    if (delivery === "control" && bytes > 16384) return this.resync(owner, id);
    const pending = [...this.#rows.values()]
      .filter((r) => r.owner.sourceKey === owner.sourceKey && !r.removed)
      .flatMap((r) => r.pending);
    if (delivery === "control" && pending.filter((r) => r.event.delivery === "control").length >= 7)
      return this.resync(owner, id);
    row.sequence++;
    if (
      delivery === "telemetry" &&
      pending.filter((r) => r.event.delivery === "telemetry").reduce((sum, r) => sum + r.bytes, 0) +
        bytes >
        262144
    ) {
      if (event.kind === "devices.telemetry" || event.kind === "devices.recordingFrames") {
        const frames = event.data.frames;
        if (frames.length)
          row.telemetryGap = {
            fromSequence: row.telemetryGap?.fromSequence ?? frames[0]!.sequence,
            toSequence: frames.at(-1)!.sequence,
            reason: "overflow",
          };
      }
      return eventSuccess({ accepted: true as const });
    }
    if (
      (event.kind === "devices.telemetry" || event.kind === "devices.recordingFrames") &&
      event.data.frames.length
    )
      delete row.telemetryGap;
    row.pending.push({ event: envelope, at: this.now(), bytes });
    if (row.active) this.#send(row, envelope);
    return eventSuccess({ accepted: true as const });
  }
  resync(owner: ResourceOwner, id: Handle) {
    return this.#resync(owner, id, "overflow");
  }
  #resync(owner: ResourceOwner, id: Handle, reason: "overflow" | "ack-timeout") {
    const row = this.#row(owner, id);
    if (row.terminal) return eventSuccess({ accepted: true as const });
    const affected: Handle[] = [];
    for (const [ref, item] of this.#rows)
      if (item.owner.sourceKey === owner.sourceKey && !item.removed && !item.terminal) {
        item.terminal = true;
        affected.push(ref);
      }
    this.revoke(owner);
    const event: Stage3EventEnvelope = {
      version: 1,
      subscriptionId: id,
      owner: row.owner,
      sequence: ++row.sequence,
      delivery: "control",
      kind: "events.resyncRequired",
      data: { reason, affected },
    };
    // The resync replaces this row's old queue and owns a fresh ACK deadline.
    row.pending = [{ event, at: this.now(), bytes: encodedBytes(event) }];
    if (row.active) this.#send(row, event);
    return eventSuccess({ accepted: true as const });
  }
  snapshot<T, D, C extends Stage3PluginErrorCode>(
    owner: ResourceOwner,
    id: Handle,
    read: () => BusinessResult<T, D, C>,
  ): BusinessResult<
    { sequence: Counter; snapshot: T },
    D | ResourceErrorDetail,
    C | PluginErrorCodeV150
  > {
    const row = this.#row(owner, id);
    if (row.removed) return stale("subscription");
    const sequence = row.sequence;
    const result = read();
    return result.ok ? { ok: true, value: { sequence, snapshot: result.value } } : result;
  }
  ack(owner: ResourceOwner, id: Handle, sequence: Counter) {
    const row = this.#row(owner, id);
    if (sequence > row.sent)
      throw new RpcError(RPC_ERRORS.invalidParams, "Cannot ACK unsent sequence");
    row.ack = Math.max(row.ack, sequence);
    row.pending = row.pending.filter((item) => item.event.sequence > row.ack);
    if (row.terminal && !row.pending.length) this.unsubscribe(owner, id);
    return eventSuccess({ acknowledged: row.ack });
  }
  unsubscribe(owner: ResourceOwner, id: Handle) {
    const row = this.#row(owner, id);
    if (row.removed) return eventSuccess({ removed: false });
    row.removed = true;
    row.pending = [];
    if (![...this.#rows.values()].some((r) => !r.removed) && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const listener of this.#removed) listener(id);
    return eventSuccess({ removed: true });
  }
  closeAfterControl(owner: ResourceOwner, id: Handle) {
    const row = this.#row(owner, id);
    row.terminal = true;
    if (!row.pending.length) this.unsubscribe(owner, id);
  }
  onRemoved(listener: (id: Handle) => void) {
    this.#removed.add(listener);
    return () => {
      this.#removed.delete(listener);
    };
  }
  disposeOwner(owner: ResourceOwner) {
    for (const [id, row] of this.#rows)
      if (resourceOwnerKey(row.owner) === resourceOwnerKey(owner)) {
        this.unsubscribe(owner, id);
        this.#rows.delete(id);
      }
  }
  sweep() {
    for (const [id, row] of this.#rows) {
      try {
        if (row.removed) continue;
        const expired = row.pending.some((item) => this.now() - item.at >= 10000);
        if (!expired) continue;
        if (row.terminal) this.unsubscribe(row.owner, id);
        else this.#resync(row.owner, id, "ack-timeout");
      } catch {
        // Timer failures stay host-side; never log native transport details.
        console.error("Device event sweep failed.");
      }
    }
  }
  diagnostics() {
    const rows = [...this.#rows.values()].filter((row) => !row.removed);
    return Object.freeze({
      subscriptions: rows.length,
      queuedEvents: rows.reduce((sum, row) => sum + row.pending.length, 0),
      queuedBytes: rows.reduce(
        (sum, row) => sum + row.pending.reduce((n, item) => n + item.bytes, 0),
        0,
      ),
    });
  }
}
