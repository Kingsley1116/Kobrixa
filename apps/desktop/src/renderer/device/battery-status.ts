import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import type { KobrixaApi } from "../../shared/api.js";
export const BATTERY_POLL_MS = 30_000;
export const LOW_BATTERY_PERCENT = 15;
export interface BatteryState {
  sessionId: string | undefined;
  percent: number | null;
  voltage: number | null;
  low: boolean;
}
const empty: BatteryState = { sessionId: undefined, percent: null, voltage: null, low: false };
export class BatteryStatus {
  private state = empty;
  private listeners = new Set<() => void>();
  private sequence = -1;
  private unsubscribe: (() => void) | undefined;
  constructor(api: Pick<KobrixaApi["device"], "onMonitor">) {
    this.unsubscribe = api.onMonitor((update) => {
      if (update.sessionId !== this.state.sessionId || update.sequence <= this.sequence) return;
      this.sequence = update.sequence;
      if (update.status === "live") this.observe(update.sessionId, update.snapshot);
    });
  }
  getSnapshot = (): BatteryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  setSession(sessionId: string | undefined): void {
    if (sessionId === this.state.sessionId) return;
    this.sequence = -1;
    this.publish({ ...empty, sessionId });
  }
  observe(sessionId: string | undefined, snapshot: DeviceMonitorSnapshot | undefined): void {
    if (!sessionId || !snapshot || sessionId !== this.state.sessionId) return;
    const { percent, voltage } = snapshot.battery;
    if (percent === this.state.percent && voltage === this.state.voltage) return;
    this.publish({
      ...this.state,
      percent,
      voltage,
      low: percent !== null && percent <= LOW_BATTERY_PERCENT,
    });
  }
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.setSession(undefined);
  }
  private publish(state: BatteryState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
