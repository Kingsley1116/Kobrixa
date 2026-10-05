import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DeviceDescriptor, DeviceMonitorSnapshot } from "@kobrixa/device";
import {
  channelReading,
  monitorChannels,
  type CalibrationProfile,
  type MonitorUpdate,
  type SensorChannel,
  type SensorLabStartRequest,
  type SensorLabState,
  type SensorLabStopReason,
  type SensorRecording,
} from "../../shared/sensor-lab.js";
import {
  SENSOR_LAB_LIMITS,
  sensorLabCalibrationSchema,
  sensorLabIdSchema,
  sensorLabStartSchema,
} from "./schema.js";
import { SensorLabStore, recordingSummary } from "./store.js";
import { sensorRecordingCsv } from "./csv.js";

export interface SensorLabDependencies {
  directory: string;
  device(sessionId: string): DeviceDescriptor;
  /** Resolves after a fresh sample; shares the visible monitor's existing scheduler. */
  acquire(sessionId: string): void | Promise<void>;
  /** Drains a pending exchange without cancelling it. */
  release(sessionId: string): void | Promise<void>;
  publish(state: SensorLabState): void;
  latest?(sessionId: string): MonitorUpdate | undefined;
  now?(): number;
  monotonic?(): number;
  store?: SensorLabStore;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Records the main monitor stream. It never performs a device read of its own. */
export class SensorLabService {
  private store: SensorLabStore;
  private now: () => number;
  private monotonic: () => number;
  private state: SensorLabState = {
    recording: undefined,
    active: false,
    waiting: false,
    saved: true,
    error: undefined,
    issues: [],
  };
  private initialized: Promise<void> | undefined;
  private updates = new Map<string, MonitorUpdate>();
  private sessionId: string | undefined;
  private startedMonotonic = 0;
  private lastSequence = -1;
  private segment = 0;
  private lastFrameWasGap = false;
  private commands: Promise<unknown> = Promise.resolve();
  private checkpointTimer: ReturnType<typeof setInterval> | undefined;
  private limitTimer: ReturnType<typeof setTimeout> | undefined;
  private checkpointPending: Promise<void> | undefined;
  private autoStopping = false;
  private disconnectedDuringStart = false;

  constructor(private dependencies: SensorLabDependencies) {
    this.store = dependencies.store ?? new SensorLabStore(dependencies.directory);
    this.now = dependencies.now ?? Date.now;
    this.monotonic = dependencies.monotonic ?? (() => performance.now());
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      this.state.issues = await this.store.initialize();
      try {
        await this.store.flush();
        this.state.saved = !this.store.hasUnsaved;
        this.state.error = undefined;
      } catch (error) {
        this.state = { ...this.state, saved: false, error: errorMessage(error) };
      }
      this.publish();
    })().catch((error) => {
      this.initialized = undefined;
      this.state = { ...this.state, saved: false, error: errorMessage(error) };
      this.publish();
      throw error;
    });
    return this.initialized;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.commands.then(work);
    this.commands = task.catch(() => {});
    return task;
  }

  private snapshot(): SensorLabState {
    return structuredClone(this.state);
  }
  private publish(): void {
    this.dependencies.publish(this.snapshot());
  }

  async getState(): Promise<SensorLabState> {
    await this.initialize();
    return this.snapshot();
  }

  start(request: SensorLabStartRequest): Promise<SensorLabState> {
    return this.serial(async () => {
      await this.initialize();
      const parsed = sensorLabStartSchema.parse(request);
      if (this.state.active) throw new Error("A recording is already running.");
      if (this.store.hasUnsaved || !this.state.saved)
        throw new Error("Save the pending recording before starting another.");
      if ((await this.store.list()).length >= SENSOR_LAB_LIMITS.recordings)
        throw new Error("The 50-recording limit has been reached. Delete a recording first.");
      let keepSubscription = false;
      try {
        await this.dependencies.acquire(parsed.sessionId);
        const update =
          this.dependencies.latest?.(parsed.sessionId) ?? this.updates.get(parsed.sessionId);
        const snapshot = update?.snapshot;
        if (
          !snapshot ||
          update?.status !== "live" ||
          update.sessionId !== parsed.sessionId ||
          Math.abs(this.now() - snapshot.sampledAt) > SENSOR_LAB_LIMITS.freshMs
        )
          throw new Error("Wait for a fresh device reading before recording.");
        const available = monitorChannels(snapshot);
        const channels = parsed.channels.map(({ source, calibration }) => {
          const current = available.find((value) => value.id === source.id);
          if (!current) throw new Error("A selected sensor changed. Select its current channel.");
          return { source: structuredClone(current), calibration: structuredClone(calibration) };
        });
        const record: SensorRecording = {
          schemaVersion: 1,
          id: randomUUID(),
          name: parsed.name.trim(),
          startedAt: this.now(),
          durationMs: 0,
          frameCount: 1,
          device: structuredClone(this.dependencies.device(parsed.sessionId)),
          channels,
          frames: [
            {
              sampledAt: snapshot.sampledAt,
              elapsedMs: 0,
              values: channels.map(({ source }) => channelReading(snapshot, source)),
              status: "ok",
              segment: 0,
            },
          ],
        };
        this.sessionId = parsed.sessionId;
        this.startedMonotonic = this.monotonic();
        this.lastSequence = update.sequence;
        this.segment = 0;
        this.lastFrameWasGap = record.frames[0]!.values.some((value) => value === null);
        this.autoStopping = false;
        this.disconnectedDuringStart = false;
        this.state = {
          ...this.state,
          recording: record,
          active: false,
          saved: false,
          waiting: this.lastFrameWasGap,
          error: undefined,
        };
        try {
          await this.store.save(record);
        } catch (error) {
          record.endedAt = this.now();
          record.reason = "interrupted";
          this.state.error = errorMessage(error);
          this.publish();
          return this.snapshot();
        }
        const currentUpdate =
          this.dependencies.latest?.(parsed.sessionId) ?? this.updates.get(parsed.sessionId);
        const changedWhileSaving =
          currentUpdate?.status === "live" &&
          currentUpdate.snapshot &&
          record.channels.some(({ source }) => sourceChanged(currentUpdate.snapshot!, source));
        if (
          this.disconnectedDuringStart ||
          currentUpdate?.status === "paused" ||
          changedWhileSaving
        ) {
          record.endedAt = this.now();
          record.durationMs = this.elapsed();
          record.reason = changedWhileSaving ? "source-changed" : "disconnected";
          this.state.waiting = false;
          await this.saveCurrent();
          return this.snapshot();
        }
        this.state.active = true;
        this.state.saved = true;
        keepSubscription = true;
        this.checkpointTimer = setInterval(() => this.checkpoint(), SENSOR_LAB_LIMITS.checkpointMs);
        this.limitTimer = setTimeout(
          () => this.requestAutoStop("limit"),
          SENSOR_LAB_LIMITS.durationMs,
        );
        this.checkpointTimer.unref?.();
        this.limitTimer.unref?.();
        this.publish();
        return this.snapshot();
      } finally {
        if (!keepSubscription) {
          this.sessionId = undefined;
          await this.dependencies.release(parsed.sessionId);
        }
      }
    });
  }

  observe(update: MonitorUpdate): void {
    const previous = this.updates.get(update.sessionId);
    if (previous && update.sequence <= previous.sequence) return;
    this.updates.set(update.sessionId, update);
    if (update.sessionId === this.sessionId && update.status === "paused" && !this.state.active)
      this.disconnectedDuringStart = true;
    if (
      !this.state.active ||
      !this.state.recording ||
      update.sessionId !== this.sessionId ||
      update.sequence <= this.lastSequence ||
      this.autoStopping
    )
      return;
    this.lastSequence = update.sequence;
    if (update.status === "paused") {
      this.requestAutoStop("disconnected");
      return;
    }
    const record = this.state.recording;
    const snapshot = update.status === "live" ? update.snapshot : undefined;
    if (snapshot && record.channels.some(({ source }) => sourceChanged(snapshot, source))) {
      this.requestAutoStop("source-changed");
      return;
    }
    const values = record.channels.map(({ source }) =>
      snapshot ? channelReading(snapshot, source) : null,
    );
    const gap = values.some((value) => value === null);
    if (gap !== this.lastFrameWasGap) this.segment++;
    this.lastFrameWasGap = gap;
    const elapsedMs = this.elapsed();
    record.frames.push({
      sampledAt: snapshot?.sampledAt ?? this.now(),
      elapsedMs,
      values,
      status: update.status === "error" ? "error" : snapshot ? "ok" : "busy",
      segment: this.segment,
    });
    record.frameCount = record.frames.length;
    record.durationMs = elapsedMs;
    this.state.waiting = gap;
    this.publish();
    if (record.frameCount >= SENSOR_LAB_LIMITS.frames || elapsedMs >= SENSOR_LAB_LIMITS.durationMs)
      this.requestAutoStop("limit");
  }

  private elapsed(): number {
    return Math.min(
      SENSOR_LAB_LIMITS.durationMs,
      Math.max(this.state.recording?.durationMs ?? 0, this.monotonic() - this.startedMonotonic),
    );
  }

  private requestAutoStop(reason: SensorLabStopReason): void {
    if (!this.state.active || this.autoStopping) return;
    this.autoStopping = true;
    // A monitor observer must never wait on the exchange that is currently publishing it.
    void this.stop(reason).catch((error) => {
      this.state.error = errorMessage(error);
      this.publish();
    });
  }

  private checkpoint(): void {
    if (!this.state.active || !this.state.recording || this.checkpointPending) return;
    this.state.recording.durationMs = this.elapsed();
    const record = structuredClone(this.state.recording);
    this.checkpointPending = this.store
      .save(record)
      .then(() => {
        this.state.saved = !this.store.hasUnsaved;
        this.state.error = undefined;
        this.publish();
      })
      .catch((error) => {
        this.state.saved = false;
        this.state.error = errorMessage(error);
        this.publish();
      })
      .finally(() => {
        this.checkpointPending = undefined;
      });
  }

  stop(reason: SensorLabStopReason = "manual"): Promise<SensorLabState> {
    return this.serial(async () => {
      await this.initialize();
      clearInterval(this.checkpointTimer);
      clearTimeout(this.limitTimer);
      this.checkpointTimer = undefined;
      this.limitTimer = undefined;
      const sessionId = this.sessionId;
      this.sessionId = undefined;
      if (this.state.active && this.state.recording) {
        this.state.recording.durationMs = this.elapsed();
        this.state.recording.endedAt = this.now();
        this.state.recording.reason = reason;
      }
      this.state.active = false;
      this.state.waiting = false;
      this.autoStopping = false;
      this.publish();
      let releaseError: unknown;
      try {
        if (sessionId) await this.dependencies.release(sessionId);
      } catch (error) {
        releaseError = error;
      }
      await this.checkpointPending;
      await this.saveCurrent();
      if (releaseError) {
        this.state.error = errorMessage(releaseError);
        this.publish();
        throw releaseError;
      }
      return this.snapshot();
    });
  }

  private async saveCurrent(): Promise<void> {
    try {
      if (this.state.recording) await this.store.save(this.state.recording);
      await this.store.flush();
      this.state.saved = !this.store.hasUnsaved;
      this.state.error = undefined;
    } catch (error) {
      this.state.saved = false;
      this.state.error = errorMessage(error);
    }
    this.publish();
  }

  retrySave(): Promise<SensorLabState> {
    return this.serial(async () => {
      await this.initialize();
      await this.checkpointPending;
      if (this.state.active && this.state.recording)
        this.state.recording.durationMs = this.elapsed();
      await this.saveCurrent();
      return this.snapshot();
    });
  }

  async list() {
    await this.initialize();
    const records = await this.store.list();
    const current = this.state.recording;
    return current
      ? records.map((record) => (record.id === current.id ? recordingSummary(current) : record))
      : records;
  }
  async read(id: string) {
    await this.initialize();
    sensorLabIdSchema.parse(id);
    if (this.state.recording?.id === id) return structuredClone(this.state.recording);
    return this.store.read(id);
  }
  delete(id: string): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      sensorLabIdSchema.parse(id);
      if (this.state.active && this.state.recording?.id === id)
        throw new Error("Stop recording before deleting it.");
      await this.store.delete(id);
      if (this.state.recording?.id === id)
        this.state = {
          ...this.state,
          recording: undefined,
          saved: !this.store.hasUnsaved,
          error: undefined,
        };
      this.publish();
    });
  }

  async listCalibrations() {
    await this.initialize();
    return this.store.listCalibrations();
  }
  saveCalibration(
    profile: Omit<CalibrationProfile, "id"> & { id?: string | undefined },
  ): Promise<CalibrationProfile> {
    return this.serial(async () => {
      await this.initialize();
      const value = sensorLabCalibrationSchema.parse(profile);
      if (value.id && !(await this.store.listCalibrations()).some(({ id }) => id === value.id))
        throw new Error("Calibration profile is no longer available.");
      try {
        const saved = await this.store.saveCalibration({ ...value, id: value.id ?? randomUUID() });
        this.state.saved = !this.store.hasUnsaved;
        if (this.state.saved) this.state.error = undefined;
        this.publish();
        return saved;
      } catch (error) {
        this.state.saved = false;
        this.state.error = errorMessage(error);
        this.publish();
        throw error;
      }
    });
  }
  deleteCalibration(id: string): Promise<void> {
    return this.serial(async () => {
      await this.initialize();
      await this.store.deleteCalibration(id);
      this.state.saved = !this.store.hasUnsaved;
      if (this.state.saved) this.state.error = undefined;
      this.publish();
    });
  }

  async exportCSVContent(id: string): Promise<string> {
    return sensorRecordingCsv(await this.read(id));
  }

  onDisconnect(sessionId: string): void {
    this.updates.delete(sessionId);
    if (sessionId === this.sessionId) {
      this.disconnectedDuringStart = true;
      this.requestAutoStop("disconnected");
    }
  }
  async suspend(): Promise<SensorLabState> {
    return this.stop("suspend");
  }
  /** Called before closing or installing an update. A failed save must block that action. */
  async flush(reason: "close" | "update" = "close"): Promise<void> {
    const state = await this.stop(reason);
    if (!state.saved) throw new Error(state.error ?? "Sensor recording has not been saved.");
  }
  async dispose(): Promise<void> {
    await this.flush("close");
  }
}

function sourceChanged(snapshot: DeviceMonitorSnapshot, source: SensorChannel): boolean {
  const port =
    source.kind === "input"
      ? snapshot.inputs.find((value) => value.port === source.port)
      : snapshot.outputs.find((value) => value.port === source.port);
  if (!port) return false; // A partial/error response is a gap, not confirmed removal.
  if (port.state === "empty") return true;
  if (port.state !== "ready") return false;
  return !monitorChannels(snapshot).some((value) => value.id === source.id);
}
