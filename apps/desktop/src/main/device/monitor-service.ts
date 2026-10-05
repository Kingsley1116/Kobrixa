import type { DeviceInputModes, DeviceMonitorSnapshot } from "@kobrixa/device";
import type { MonitorResult } from "../../shared/api.js";
import type { MonitorUpdate } from "../../shared/sensor-lab.js";

interface MonitorDevice {
  monitor(id: string): Promise<MonitorResult<DeviceMonitorSnapshot>>;
  inputModes(id: string, port: number, type: number): Promise<MonitorResult<DeviceInputModes>>;
  setInputMode(
    id: string,
    port: number,
    type: number,
    mode: number,
  ): Promise<MonitorResult<DeviceMonitorSnapshot>>;
}

/** One main-process clock serves the visible monitor and background recording. */
export class MonitorService {
  private visible: string | undefined;
  private recording: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private metadata = 0;
  private sequence = 0;
  private disposed = false;
  private updates = new Map<string, MonitorUpdate>();
  private listeners = new Set<(update: MonitorUpdate) => void>();

  constructor(
    private devices: MonitorDevice,
    private publish: (update: MonitorUpdate) => void,
  ) {}

  subscribe(listener: (update: MonitorUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  latest = (id: string): MonitorUpdate | undefined => this.updates.get(id);
  get recordingSession(): string | undefined {
    return this.recording;
  }
  get busy(): boolean {
    return !!this.pending || this.metadata > 0;
  }
  private get session(): string | undefined {
    return this.recording ?? this.visible;
  }
  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private emit(id: string, patch: Omit<MonitorUpdate, "sessionId" | "sequence">): void {
    const update = {
      ...patch,
      recording: this.recording === id,
      sessionId: id,
      sequence: ++this.sequence,
    };
    this.updates.set(id, update);
    this.publish(update);
    for (const listener of this.listeners) listener(update);
  }
  private schedule(): void {
    this.clearTimer();
    if (!this.disposed && this.session && !this.pending && !this.metadata)
      this.timer = setTimeout(() => void this.poll(), 500);
  }
  private poll(): Promise<void> {
    this.clearTimer();
    if (this.pending) return this.pending;
    const id = this.session;
    if (!id || this.disposed || this.metadata) return Promise.resolve();
    const work = Promise.resolve()
      .then(async () => {
        if (this.session !== id || this.disposed) return;
        try {
          const result = await this.devices.monitor(id);
          if (this.session !== id || this.disposed) return;
          const snapshot = this.latest(id)?.snapshot;
          if (result.status === "ok") this.emit(id, { status: "live", snapshot: result.value });
          else if (result.status === "busy") this.emit(id, { status: "waiting", snapshot });
          else this.emit(id, { status: "error", snapshot, error: result.message });
        } catch (error) {
          if (this.session === id && !this.disposed)
            this.emit(id, {
              status: "error",
              snapshot: this.latest(id)?.snapshot,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      })
      .finally(() => {
        if (this.pending === work) this.pending = undefined;
        this.schedule();
      });
    this.pending = work;
    return work;
  }

  async watch(id: string, enabled: boolean): Promise<MonitorUpdate> {
    if (this.disposed) throw new Error("Monitor is closed.");
    if (enabled) {
      if (this.recording && this.recording !== id) throw new Error("Another EV3 is recording.");
      this.visible = id;
      if (!this.latest(id)) this.emit(id, { status: "waiting" });
      if (!this.pending && !this.metadata) void this.poll();
    } else if (this.visible === id) {
      this.visible = undefined;
      if (!this.session) {
        this.clearTimer();
        await this.pending;
        this.emit(id, { status: "paused", snapshot: this.latest(id)?.snapshot });
      }
    }
    return this.latest(id) ?? { sessionId: id, sequence: this.sequence, status: "paused" };
  }

  async acquire(id: string): Promise<void> {
    if (this.disposed || this.recording) throw new Error("A recording is already active.");
    if (this.metadata) throw new Error("Wait for the sensor mode operation to finish.");
    if (this.visible && this.visible !== id) throw new Error("The EV3 session changed.");
    this.recording = id;
    this.clearTimer();
    await this.pending;
    await this.poll();
    if (this.recording !== id || this.latest(id)?.status !== "live") {
      await this.release(id);
      throw new Error("Wait for a fresh EV3 reading before recording.");
    }
  }
  async release(id: string): Promise<void> {
    if (this.recording === id) this.recording = undefined;
    this.clearTimer();
    await this.pending;
    if (!this.session) this.emit(id, { status: "paused", snapshot: this.latest(id)?.snapshot });
    else if (this.latest(id)) this.emit(id, { ...this.latest(id)!, recording: false });
    this.schedule();
  }
  async disconnect(id: string): Promise<void> {
    if (this.visible === id) this.visible = undefined;
    if (this.recording === id) this.recording = undefined;
    this.clearTimer();
    await this.pending;
    this.emit(id, { status: "paused", snapshot: this.latest(id)?.snapshot });
    this.updates.delete(id);
    this.schedule();
  }

  private async modeRequest<T>(
    id: string,
    action: () => Promise<MonitorResult<T>>,
  ): Promise<MonitorResult<T>> {
    this.metadata++;
    this.clearTimer();
    try {
      await this.pending;
      if (this.disposed || this.session !== id) return { status: "busy" };
      if (
        this.latest(id)?.status !== "live" ||
        this.latest(id)?.snapshot?.program.status !== "stopped"
      )
        return { status: "busy" };
      return await action();
    } finally {
      this.metadata--;
      this.schedule();
    }
  }
  inputModes(id: string, port: number, type: number): Promise<MonitorResult<DeviceInputModes>> {
    return this.modeRequest(id, () => this.devices.inputModes(id, port, type));
  }
  setInputMode(
    id: string,
    port: number,
    type: number,
    mode: number,
  ): Promise<MonitorResult<DeviceMonitorSnapshot>> {
    if (this.recording)
      return Promise.resolve({
        status: "error",
        category: "device",
        message: "Stop recording before changing sensor modes. / 請先停止記錄再切換感測器模式。",
      });
    return this.modeRequest(id, async () => {
      const result = await this.devices.setInputMode(id, port, type, mode);
      if (result.status === "ok" && this.session === id)
        this.emit(id, { status: "live", snapshot: result.value });
      return result;
    });
  }
  async pause(): Promise<void> {
    this.visible = undefined;
    this.clearTimer();
    await this.pending;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.visible = this.recording = undefined;
    this.clearTimer();
    await this.pending;
    this.listeners.clear();
  }
}
