import type { LegacyDevice } from "../device-broker/legacy-device.js";
import { monitorProjection } from "../device-broker/legacy-device.js";
import type { MonitorUpdate } from "../../shared/sensor-lab.js";
/** Retained core battery demand: uses the one broker feed, never a feature sampler or mode writer. */
export class MonitorService {
  private demands = new Map<string, { cancelled: boolean; ready: Promise<() => Promise<void>> }>();
  private updates = new Map<string, MonitorUpdate>();
  private disposed = false;
  private sequence = 0;
  constructor(
    private devices: Pick<LegacyDevice, "watch">,
    private publish: (update: MonitorUpdate) => void,
  ) {}
  latest = (id: string): MonitorUpdate | undefined => this.updates.get(id);
  private emit(update: MonitorUpdate): void {
    this.updates.set(update.sessionId, update);
    this.publish(update);
  }
  async watch(id: string, enabled: boolean, owner = 0): Promise<MonitorUpdate> {
    const key = `${owner}:${id}`;
    if (enabled && !this.demands.has(key)) {
      if (this.disposed) throw new Error("Monitor is closed.");
      const entry = { cancelled: false, ready: Promise.resolve(async () => {}) };
      this.demands.set(key, entry);
      entry.ready = this.devices.watch(
        id,
        500,
        (snapshot, sources) => {
          if (entry.cancelled || this.disposed) return;
          const value =
            snapshot.frame && snapshot.status === "fresh"
              ? monitorProjection(sources, snapshot.frame)
              : undefined;
          this.emit({
            sessionId: id,
            sequence: ++this.sequence,
            status: value ? "live" : "waiting",
            snapshot: value ?? this.latest(id)?.snapshot,
          });
        },
        () => {
          if (entry.cancelled || this.demands.get(key) !== entry) return;
          entry.cancelled = true;
          this.demands.delete(key);
          this.emit({ sessionId: id, sequence: ++this.sequence, status: "paused" });
        },
      );
      try {
        await entry.ready;
      } catch (error) {
        if (this.demands.get(key) === entry) this.demands.delete(key);
        throw error;
      }
    } else if (!enabled) {
      const entry = this.demands.get(key);
      if (entry) {
        entry.cancelled = true;
        this.demands.delete(key);
        await (
          await entry.ready
        )();
      }
    }
    return this.latest(id) ?? { sessionId: id, sequence: this.sequence, status: "paused" };
  }
  async disconnect(id: string): Promise<void> {
    for (const [key, entry] of [...this.demands])
      if (key.endsWith(`:${id}`)) {
        entry.cancelled = true;
        this.demands.delete(key);
        await (
          await entry.ready
        )();
      }
    this.emit({ sessionId: id, sequence: ++this.sequence, status: "paused" });
    this.updates.delete(id);
  }
  async pause(): Promise<void> {
    for (const [key, entry] of [...this.demands]) {
      entry.cancelled = true;
      this.demands.delete(key);
      await (
        await entry.ready
      )();
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pause();
  }
}
