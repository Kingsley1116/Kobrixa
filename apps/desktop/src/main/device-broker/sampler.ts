import type { ReadSnapshot, TelemetryFrame } from "@kobrixa/plugin-protocol";
import { deviceFailure } from "./registry.js";
export class Sampler {
  #demands = new Map<string, 500 | 30000>();
  #listeners = new Set<(frame: TelemetryFrame) => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<ReadSnapshot> | null = null;
  #frame: TelemetryFrame | null = null;
  #receipt: number | null = null;
  #sequence = 0;
  #revision = 0;
  #closed = false;
  readonly #origin: number;
  constructor(
    private readonly input: {
      sessionId: string;
      now: () => number;
      read: () => Promise<TelemetryFrame>;
      busy: () => boolean;
    },
    continuity?: { origin: number; sequence: number; revision: number },
  ) {
    this.#origin = continuity?.origin ?? input.now();
    this.#sequence = continuity?.sequence ?? 0;
    this.#revision = continuity?.revision ?? 0;
  }
  /** Carry only the same-session clock; no cached frame, consumer or demand. */
  restart(): Sampler {
    if (!this.#closed || this.#pending) throw new Error("Sampler not settled");
    return new Sampler(this.input, {
      origin: this.#origin,
      sequence: this.#sequence,
      revision: this.#revision,
    });
  }
  async settled(deadline: number): Promise<void> {
    if (!this.#pending) return;
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        this.#pending.catch(() => {}),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Sampler deadline")),
            Math.max(0, deadline - this.input.now()),
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  snapshot(): ReadSnapshot {
    const ageMs = this.#receipt === null ? null : Math.max(0, this.input.now() - this.#receipt);
    return {
      sessionId: this.input.sessionId,
      revision: this.#revision,
      status: this.input.busy()
        ? "busy"
        : ageMs === null
          ? "unavailable"
          : ageMs <= 2500
            ? "fresh"
            : "stale",
      ageMs,
      frame: this.#frame ? structuredClone(this.#frame) : null,
    };
  }
  demand(id: string, interval: 500 | 30000): () => void {
    this.#demands.set(id, interval);
    this.#schedule(0);
    return () => {
      this.#demands.delete(id);
      if (!this.#demands.size && this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
    };
  }
  subscribe(listener: (frame: TelemetryFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #schedule(delay: number): void {
    if (this.#closed || this.#timer || this.#pending || !this.#demands.size) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.fresh().catch(() => {});
    }, delay);
  }
  fresh(): Promise<ReadSnapshot> {
    if (this.#closed) return Promise.reject(new Error("Sampler closed"));
    if (this.input.busy()) {
      const gap: TelemetryFrame = {
        sequence: ++this.#sequence,
        sampledAt: Date.now(),
        elapsedMs: this.input.now() - this.#origin,
        sourceRevision: this.#frame?.sourceRevision ?? 0,
        status: "busy",
        values: (this.#frame?.values ?? []).map((v) => ({ channelId: v.channelId, value: null })),
        program: "unknown",
        gap: { fromSequence: this.#sequence, toSequence: this.#sequence, reason: "busy" },
      };
      for (const listener of this.#listeners) {
        try {
          listener(structuredClone(gap));
        } catch {
          /* Isolate shared sampler consumers. */
        }
      }
      this.#schedule(Math.min(...this.#demands.values(), 30000));
      try {
        return deviceFailure("PLUGIN_E_DEVICE_BUSY", "foreground");
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (this.#pending) return this.#pending;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending = this.input
      .read()
      .then(
        (raw) => {
          if (this.#closed) throw new Error("Sampler retired");
          return this.receive(raw);
        },
        (error) => {
          const sample: TelemetryFrame = {
            sequence: ++this.#sequence,
            sampledAt: Date.now(),
            elapsedMs: this.input.now() - this.#origin,
            sourceRevision: this.#frame?.sourceRevision ?? 0,
            status: "error",
            values: [],
            program: "unknown",
            gap: { fromSequence: this.#sequence, toSequence: this.#sequence, reason: "read-error" },
          };
          for (const listener of this.#listeners) {
            try {
              listener(structuredClone(sample));
            } catch {
              /* Isolate shared sampler consumers. */
            }
          }
          throw error;
        },
      )
      .finally(() => {
        this.#pending = null;
        this.#schedule([...this.#demands.values()].includes(500) ? 500 : 30000);
      });
    return this.#pending;
  }
  receive(raw: TelemetryFrame): ReadSnapshot {
    if (this.#closed) throw new Error("Sampler retired");
    if (raw.sequence !== 0 || raw.sampledAt !== 0 || raw.elapsedMs !== 0)
      return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "provider-contract");
    const receipt = this.input.now();
    const sample = {
      ...raw,
      sequence: ++this.#sequence,
      sampledAt: Date.now(),
      elapsedMs: receipt - this.#origin,
    };
    this.#revision++;
    if (sample.status === "ok") {
      this.#frame = sample;
      this.#receipt = receipt;
    }
    for (const listener of this.#listeners) {
      try {
        listener(structuredClone(sample));
      } catch {
        /* Isolate shared sampler consumers. */
      }
    }
    return this.snapshot();
  }
  dispose(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#demands.clear();
    this.#listeners.clear();
  }
}

import { RpcError, RPC_ERRORS, type SourceCatalog } from "@kobrixa/plugin-protocol";
import type { CoreTelemetrySubscription } from "./broker-port.js";
import type { JournalOwner } from "@kobrixa/plugin-runtime";
import { quota } from "./registry.js";
type CoreValue = { sequence: number; snapshot: ReadSnapshot; sources: SourceCatalog };
type CoreRow = {
  pending: Array<{ value: CoreValue; bytes: number; at: number; control: boolean }>;
  dispose: () => Promise<void>;
  valid: () => boolean;
};
/** All demands of a JournalOwner share a budget, including unacknowledged deliveries. */
export class CoreTelemetryLedger {
  #owners = new Map<string, Map<string, CoreRow>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly now: () => number) {}
  #endOwner(key: string) {
    for (const row of [...(this.#owners.get(key)?.values() ?? [])]) void row.dispose();
  }
  dispose() {
    for (const key of [...this.#owners.keys()]) this.#endOwner(key);
  }
  subscribe(input: {
    owner: Extract<JournalOwner, { kind: "core" }>;
    id: string;
    sampler: Sampler;
    channelIds: readonly string[];
    intervalMs: 500 | 30000;
    sources: () => SourceCatalog;
    valid: () => boolean;
    receive: (value: CoreValue) => void;
  }): CoreTelemetrySubscription {
    const key = JSON.stringify([
      input.owner.kind,
      input.owner.adapter,
      input.owner.hostEpoch,
      input.owner.workbenchInstance,
    ]);
    if (!input.valid()) throw new Error("Core workbench retired");
    const rows = this.#owners.get(key) ?? new Map<string, CoreRow>();
    if (rows.size >= 32) quota("subscription", 32);
    this.#owners.set(key, rows);
    let active = false,
      disposed = false,
      sent = 0,
      acknowledged = 0,
      sequence = 0,
      sourceRevision = input.sources().sourceRevision;
    const pending: CoreRow["pending"] = [];
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      unlisten();
      undemand();
      pending.splice(0);
      rows.delete(input.id);
      if (!rows.size) this.#owners.delete(key);
      if (!this.#owners.size && this.#timer) {
        clearInterval(this.#timer);
        this.#timer = null;
      }
    };
    const deliver = (value: CoreValue) => {
      if (disposed) return;
      if (!input.valid()) {
        this.#endOwner(key);
        return;
      }
      sent = value.sequence;
      try {
        input.receive(value);
      } catch {
        void dispose();
      }
    };
    const undemand = input.sampler.demand(input.id, input.intervalMs);
    const unlisten = input.sampler.subscribe((frame) => {
      if (disposed) return;
      if (!input.valid()) {
        this.#endOwner(key);
        return;
      }
      const snapshot = input.sampler.snapshot();
      snapshot.frame = {
        ...frame,
        values: frame.values.filter((value) => input.channelIds.includes(value.channelId)),
      };
      const sources = structuredClone(input.sources()),
        control = sources.sourceRevision !== sourceRevision;
      const value = { sequence: ++sequence, snapshot, sources };
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      const queued = [...rows.values()].flatMap((row) => row.pending);
      if (
        bytes > 65536 ||
        queued.reduce((sum, row) => sum + row.bytes, 0) + bytes > 262144 ||
        (control && (bytes > 16384 || queued.filter((row) => row.control).length >= 7))
      ) {
        this.#endOwner(key);
        return;
      }
      sourceRevision = sources.sourceRevision;
      pending.push({ value, bytes, at: this.now(), control });
      if (active) deliver(value);
    });
    rows.set(input.id, { pending, dispose, valid: input.valid });
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        for (const [owner, demands] of this.#owners)
          if (
            [...demands.values()].some(
              (row) => !row.valid() || row.pending.some((item) => this.now() - item.at >= 10000),
            )
          )
            this.#endOwner(owner);
      }, 500);
      this.#timer.unref();
    }
    return {
      initial: { snapshot: input.sampler.snapshot(), sources: structuredClone(input.sources()) },
      activate() {
        if (active || disposed) return;
        active = true;
        for (const item of [...pending]) deliver(item.value);
      },
      ack(value) {
        if (!Number.isSafeInteger(value) || value < 0 || value > sent)
          throw new RpcError(RPC_ERRORS.invalidParams, "Cannot ACK an unsent core sample");
        acknowledged = Math.max(acknowledged, value);
        while (pending[0] && pending[0].value.sequence <= acknowledged) pending.shift();
      },
      dispose,
    };
  }
}
