import type { SourceCatalog, TelemetryFrame } from "@kobrixa/plugin-protocol";
import type { MonitorUpdate, SensorChannel } from "../../shared/sensor-lab.js";
import { type LegacyDevice, monitorProjection } from "./legacy-device.js";
type Active = {
  sessionId: string;
  reservationId: string;
  sources: SourceCatalog;
  sequence: number;
  remove: () => Promise<void>;
  reads: Promise<void>;
  reading: boolean;
  again: boolean;
};
export class LegacyLab {
  private active: Active | undefined;
  private opening = false;
  private updates = new Map<string, MonitorUpdate>();
  private updateSequence = 0;
  private ending: Promise<void> | undefined;
  constructor(
    private device: LegacyDevice,
    private publish: (update: MonitorUpdate) => void,
  ) {}
  latest = (id: string): MonitorUpdate | undefined => this.updates.get(id);
  descriptor = (id: string) => this.device.descriptor(id);
  private update(
    sessionId: string,
    status: MonitorUpdate["status"],
    snapshot?: MonitorUpdate["snapshot"],
  ): void {
    const value: MonitorUpdate = {
      sessionId,
      sequence: ++this.updateSequence,
      status,
      recording: true,
      snapshot,
    };
    this.updates.set(sessionId, value);
    this.publish(value);
  }
  private emit(active: Active, frame: TelemetryFrame): void {
    if (frame.sequence <= active.sequence) return;
    if (frame.sequence > active.sequence + 1 && active.sequence >= 0)
      this.update(active.sessionId, "waiting");
    active.sequence = frame.sequence;
    this.update(
      active.sessionId,
      frame.status === "ok" ? "live" : frame.status === "error" ? "error" : "waiting",
      frame.status === "ok" ? monitorProjection(active.sources, frame) : undefined,
    );
  }
  private async read(active: Active, through?: number): Promise<void> {
    let target = through;
    for (;;) {
      if (target !== undefined && active.sequence >= target) return;
      const page = await this.device.request("devices/recording/read", {
        reservationId: active.reservationId,
        afterSequence: active.sequence,
        limit: 64,
      });
      target ??= page.reservation.lastSequence;
      if (target === undefined || !Number.isSafeInteger(target))
        throw new Error("Invalid recording sequence.");
      if (page.gap && page.gap.toSequence > active.sequence) {
        this.update(active.sessionId, "waiting");
        active.sequence = page.gap.toSequence;
      }
      for (const frame of page.frames) {
        if (frame.sequence > target) break;
        this.emit(active, frame);
      }
      if (!page.hasMore || active.sequence >= target) return;
      if (page.nextSequence <= active.sequence && !page.frames.length)
        throw new Error("Recording read made no progress.");
      active.sequence = Math.max(active.sequence, page.nextSequence);
    }
  }
  async acquire(sessionId: string, channels: SensorChannel[]): Promise<void> {
    if (this.active || this.opening || this.ending)
      throw new Error("A recording is already active.");
    this.opening = true;
    let reservationId: string | undefined;
    try {
      const { sources } = await this.device.request("devices/session", { sessionId });
      const channelIds = channels.map((old) => {
        const current = sources.channels.find(
          (c) =>
            c.portId === `${old.kind === "input" ? "input" : "output"}:${old.port}` &&
            c.typeId === `ev3:${old.type}` &&
            c.component === old.channel &&
            (old.kind === "output" || c.modeId === `mode:${old.mode}`) &&
            c.unit === old.unit,
        );
        if (!current) throw new Error("Recording source changed.");
        return current.channelId;
      });
      const result = await this.device.request("devices/recording/reserve", {
        sessionId,
        channelIds,
        expectedSourceRevision: sources.sourceRevision,
      });
      reservationId = result.reservation.reservationId;
      const active: Active = {
        sessionId,
        reservationId: result.reservation.reservationId,
        sources,
        sequence: result.firstFrame.sequence - 1,
        remove: async () => {},
        reads: Promise.resolve(),
        reading: false,
        again: false,
      };
      this.active = active;
      this.emit(active, result.firstFrame);
      active.remove = await this.device.watch(
        sessionId,
        500,
        (snapshot, currentSources) => {
          if (this.active !== active) return;
          if (snapshot.status === "unavailable") {
            this.update(sessionId, "paused");
            return;
          }
          const changed = result.reservation.channels.some(
            (pinned) =>
              !currentSources.channels.some(
                (current) =>
                  current.channelId === pinned.channelId &&
                  current.typeId === pinned.typeId &&
                  current.modeId === pinned.modeId &&
                  current.unit === pinned.unit,
              ),
          );
          if (changed) {
            // Let the unchanged legacy recorder detect the metadata change before
            // accepting any new-source sample. This never extends a reservation.
            if (snapshot.frame)
              this.update(sessionId, "live", monitorProjection(currentSources, snapshot.frame));
            else this.update(sessionId, "paused");
            return;
          }
          // Telemetry is only a wake-up. Read the original reservation ring so a
          // coalesced event cannot silently lose samples or overflow evidence.
          active.again = true;
          if (active.reading) return;
          active.reading = true;
          active.reads = (async () => {
            do {
              active.again = false;
              await this.read(active);
            } while (active.again && this.active === active);
          })()
            .catch(() => {
              if (this.active === active) this.update(sessionId, "paused");
            })
            .finally(() => {
              active.reading = false;
            });
        },
        () => {
          if (this.active === active) this.update(sessionId, "paused");
        },
      );
    } catch (error) {
      const active = this.active;
      this.active = undefined;
      try {
        if (reservationId)
          await this.device.request("devices/recording/release", { reservationId });
      } catch {
        /* Preserve the acquisition failure; cleanup remains independent. */
      }
      try {
        await active?.remove();
      } catch {
        /* Preserve the original error. */
      }
      throw error;
    } finally {
      this.opening = false;
    }
  }
  release(sessionId: string): Promise<void> {
    if (this.ending) return this.ending;
    const active = this.active;
    if (!active || active.sessionId !== sessionId) return Promise.resolve();
    this.active = undefined;
    const work = (async () => {
      const end = await this.device.request("devices/recording/release", {
        reservationId: active.reservationId,
      });
      await active.reads;
      await this.read(active, end.reservation.lastSequence);
    })().finally(async () => {
      try {
        await active.remove();
      } finally {
        this.ending = undefined;
      }
    });
    this.ending = work;
    return work;
  }
}
