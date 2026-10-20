import { randomUUID } from "node:crypto";
import type {
  ChannelDefinition,
  ReadSnapshot,
  TelemetryFrame,
  ReservationSnapshot,
  ResourceOwner,
  RecordingReadValue,
} from "@kobrixa/plugin-protocol";
import type {
  ReservationBindingPort,
  ReservationBinding,
  ReservationEnded,
} from "@kobrixa/plugin-runtime";
import { resourceOwnerKey, stale, deviceFailure, quota } from "./registry.js";
type Row = {
  binding: ReservationBinding;
  snapshot: ReservationSnapshot;
  frames: TelemetryFrame[];
  bytes: number;
  started: number;
  sourceRevision: number;
  ended: ReservationEnded | null;
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export class Reservations implements ReservationBindingPort {
  #changes = new Set<(snapshot: ReservationSnapshot) => void>();
  subscribe(listener: (snapshot: ReservationSnapshot) => void): () => void {
    this.#changes.add(listener);
    return () => {
      this.#changes.delete(listener);
    };
  }
  #changed(row: Row) {
    for (const listener of this.#changes) listener(structuredClone(row.snapshot));
  }
  #rows = new Map<string, Row>();
  #active: string | null = null;
  #reserving = false;
  #listeners = new Set<(event: ReservationEnded) => void>();
  constructor(private readonly now: () => number) {}
  get active(): boolean {
    return this.#active !== null || this.#reserving;
  }
  async reserve(input: {
    owner: ResourceOwner;
    sessionId: string;
    providerGeneration: number;
    channels: ChannelDefinition[];
    sourceRevision: number;
    check: () => void;
    fresh: () => Promise<ReadSnapshot>;
  }): Promise<{ reservation: ReservationSnapshot; firstFrame: TelemetryFrame }> {
    if (this.active) return deviceFailure("PLUGIN_E_DEVICE_BUSY", "recording");
    if (
      input.channels.length < 1 ||
      input.channels.length > 4 ||
      new Set(input.channels.map((c) => c.channelId)).size !== input.channels.length ||
      input.channels.some((c) => c.state !== "ready" || c.kind.startsWith("battery"))
    )
      return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "source-changed");
    for (const [id, row] of this.#rows)
      if (row.ended && this.now() >= row.ended.endedMonotonicMs + 10000) this.#rows.delete(id);
    if (this.#rows.size >= 256) quota("reservation", 256);
    this.#reserving = true;
    try {
      input.check();
      const fresh = await input.fresh();
      input.check();
      if (
        fresh.status !== "fresh" ||
        fresh.ageMs === null ||
        fresh.ageMs > 2500 ||
        !fresh.frame ||
        fresh.frame.sourceRevision !== input.sourceRevision
      )
        return deviceFailure("PLUGIN_E_DEVICE_OPERATION", "source-changed");
      const id = randomUUID();
      const firstFrame = this.#select(fresh.frame, input.channels);
      const snapshot: ReservationSnapshot = {
        reservationId: id,
        sessionId: input.sessionId,
        revision: 1,
        state: "active",
        channels: structuredClone(input.channels),
        firstSequence: firstFrame.sequence,
        lastSequence: firstFrame.sequence,
        reason: "active",
      };
      const binding = {
        owner: structuredClone(input.owner),
        reservationId: id,
        sessionId: input.sessionId,
        providerGeneration: input.providerGeneration,
      };
      this.#rows.set(id, {
        binding,
        snapshot,
        frames: [firstFrame],
        bytes: bytes(firstFrame),
        started: this.now(),
        sourceRevision: input.sourceRevision,
        ended: null,
      });
      this.#active = id;
      this.#changed(this.#rows.get(id)!);
      return { reservation: structuredClone(snapshot), firstFrame: structuredClone(firstFrame) };
    } finally {
      this.#reserving = false;
    }
  }
  #select(frame: TelemetryFrame, channels: ChannelDefinition[]): TelemetryFrame {
    return {
      ...structuredClone(frame),
      values: channels.map((c) => ({
        channelId: c.channelId,
        value: frame.values.find((v) => v.channelId === c.channelId)?.value ?? null,
      })),
    };
  }
  append(frame: TelemetryFrame): void {
    const row = this.#active ? this.#rows.get(this.#active) : undefined;
    if (!row) return;
    if (frame.sourceRevision !== row.sourceRevision) {
      this.end(row.binding.reservationId, "source-changed", true);
      return;
    }
    if (
      this.now() - row.started >= 1800000 ||
      row.snapshot.lastSequence - row.snapshot.firstSequence + 1 >= 3600
    ) {
      this.end(row.binding.reservationId, "limit", true);
      return;
    }
    if (frame.sequence <= row.snapshot.lastSequence) return;
    const selected = this.#select(frame, row.snapshot.channels),
      size = bytes(selected);
    if (size > 262144) {
      this.end(row.binding.reservationId, "overflow", true);
      return;
    }
    while (row.frames.length && row.bytes + size > 262144) row.bytes -= bytes(row.frames.shift()!);
    row.frames.push(selected);
    row.bytes += size;
    row.snapshot.lastSequence = frame.sequence;
    row.snapshot.revision++;
    this.#changed(row);
  }
  #owned(owner: ResourceOwner, id: string): Row {
    const row = this.#rows.get(id);
    if (!row || resourceOwnerKey(owner) !== resourceOwnerKey(row.binding.owner))
      return stale("reservation");
    return row;
  }
  query(owner: ResourceOwner, id: string): ReservationSnapshot {
    return structuredClone(this.#owned(owner, id).snapshot);
  }
  read(owner: ResourceOwner, id: string, afterSequence: number, limit: number): RecordingReadValue {
    const row = this.#owned(owner, id);
    if (row.ended && this.now() >= row.ended.endedMonotonicMs + 10000) {
      row.frames = [];
      row.bytes = 0;
      return stale("reservation");
    }
    const candidates = row.frames.filter((f) => f.sequence > afterSequence),
      frames: TelemetryFrame[] = [];
    const oldest = row.frames[0]?.sequence ?? row.snapshot.lastSequence + 1;
    const gap =
      afterSequence + 1 < oldest
        ? { fromSequence: afterSequence + 1, toSequence: oldest - 1, reason: "overflow" as const }
        : null;
    const result: RecordingReadValue = {
      reservation: structuredClone(row.snapshot),
      frames,
      gap,
      nextSequence: afterSequence,
      hasMore: false,
    };
    for (const frame of candidates.slice(0, limit)) {
      frames.push(structuredClone(frame));
      if (bytes(result) > 65536) {
        frames.pop();
        break;
      }
      result.nextSequence = frame.sequence;
    }
    result.hasMore = candidates.length > frames.length;
    return result;
  }
  validate(owner: ResourceOwner, id: string): ReservationBinding | null {
    const row = this.#rows.get(id);
    return row && !row.ended && resourceOwnerKey(owner) === resourceOwnerKey(row.binding.owner)
      ? structuredClone(row.binding)
      : null;
  }
  onEnded(listener: (event: ReservationEnded) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  end(id: string, reason: ReservationEnded["reason"], healthy: boolean): ReservationEnded | null {
    const row = this.#rows.get(id);
    if (!row) return null;
    if (row.ended) return row.ended;
    row.snapshot.state = "ended";
    row.snapshot.reason = reason;
    row.snapshot.revision++;
    if (this.#active === id) this.#active = null;
    const endedMonotonicMs = this.now();
    const drain = healthy
      ? Object.freeze({
          owner: row.binding.owner,
          reservationId: id,
          lastSequence: row.snapshot.lastSequence,
          expiresMonotonicMs: endedMonotonicMs + 10000,
        })
      : null;
    row.ended = Object.freeze({
      ...row.binding,
      reason,
      lastSequence: row.snapshot.lastSequence,
      endedMonotonicMs,
      drain,
    });
    this.#changed(row);
    for (const listener of this.#listeners)
      try {
        listener(row.ended);
      } catch {
        /* Core coordinator records its listener failure; frame admission is already closed. */
      }
    return row.ended;
  }
  endOwner(
    owner: ResourceOwner,
    reason: ReservationEnded["reason"],
    healthy: boolean,
  ): ReservationEnded[] {
    return [...this.#rows.values()]
      .filter((r) => resourceOwnerKey(owner) === resourceOwnerKey(r.binding.owner))
      .map((r) => this.end(r.binding.reservationId, reason, healthy)!)
      .filter(Boolean);
  }
  endSession(
    sessionId: string,
    reason: ReservationEnded["reason"],
    healthy: boolean,
  ): ReservationEnded[] {
    return [...this.#rows.values()]
      .filter((r) => r.binding.sessionId === sessionId)
      .map((r) => this.end(r.binding.reservationId, reason, healthy)!)
      .filter(Boolean);
  }
}
