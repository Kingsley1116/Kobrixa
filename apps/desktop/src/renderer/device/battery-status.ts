import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import type { MonitorResult } from "../../shared/api.js";

export const BATTERY_POLL_MS = 30_000;
/** EV3 bricks start browning out motors well before 0%; warn with room to swap batteries. */
export const LOW_BATTERY_PERCENT = 15;

export interface BatteryState {
  sessionId: string | undefined;
  percent: number | null;
  voltage: number | null;
  low: boolean;
}

const empty: BatteryState = { sessionId: undefined, percent: null, voltage: null, low: false };

/** Light background battery reads for the status bar while an EV3 is connected. */
export class BatteryStatus {
  private state = empty;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;

  constructor(
    private readonly read: (sessionId: string) => Promise<MonitorResult<DeviceMonitorSnapshot>>,
    private readonly interval = BATTERY_POLL_MS,
  ) {}

  getSnapshot = (): BatteryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setSession(sessionId: string | undefined): void {
    if (sessionId === this.state.sessionId) return;
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    this.publish({ ...empty, sessionId });
    if (!sessionId) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.interval);
  }

  /** Accepts readings the monitor panel already sampled, avoiding a second exchange. */
  observe(sessionId: string | undefined, snapshot: DeviceMonitorSnapshot | undefined): void {
    if (!snapshot || sessionId !== this.state.sessionId) return;
    this.apply(snapshot);
  }

  dispose(): void {
    this.setSession(undefined);
  }

  private async poll(): Promise<void> {
    const sessionId = this.state.sessionId;
    const generation = this.generation;
    if (!sessionId) return;
    try {
      const result = await this.read(sessionId);
      // A busy brick (running program, file transfer) keeps the last reading.
      if (result.status === "ok" && generation === this.generation) this.apply(result.value);
    } catch {
      // Background reads must never surface errors; the device panel reports them.
    }
  }

  private apply(snapshot: DeviceMonitorSnapshot): void {
    const { percent, voltage } = snapshot.battery;
    if (percent === this.state.percent && voltage === this.state.voltage) return;
    this.publish({
      ...this.state,
      percent,
      voltage,
      low: percent !== null && percent <= LOW_BATTERY_PERCENT,
    });
  }

  private publish(state: BatteryState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
