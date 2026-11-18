import { BatteryStatus } from "./battery-status.js";
import type { KobrixaApi } from "../../shared/api.js";

/** Retained core status demand. Uses the host's broker sampler, never a renderer
 * timer or the retired feature's sensor/mode controls. */
export class CoreBatteryMonitor {
  private readonly battery: BatteryStatus;
  private sessionId: string | undefined;
  private generation = 0;
  private demandedSession: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly api: Pick<KobrixaApi["device"], "onMonitor" | "watchMonitor">) {
    this.battery = new BatteryStatus(api);
  }
  getSnapshot = () => this.battery.getSnapshot();
  subscribe = (listener: () => void) => this.battery.subscribe(listener);

  setSession(sessionId: string | undefined): void {
    if (this.disposed || sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.battery.setSession(sessionId);
    const generation = ++this.generation;
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation) return;
        // A failed release remains recorded, so a replacement cannot leave
        // the old demand behind or subscribe before cleanup succeeds.
        if (this.demandedSession) {
          await this.api.watchMonitor(this.demandedSession, false);
          this.demandedSession = undefined;
        }
        if (sessionId && generation === this.generation && !this.disposed) {
          this.demandedSession = sessionId;
          await this.api.watchMonitor(sessionId, true);
        }
      });
    // Status is unavailable after a failed demand; explicit close/update drains
    // still observe the rejection. Never manufacture a battery reading.
    void this.pending.catch(() => {});
  }
  async drain(): Promise<void> {
    this.setSession(undefined);
    await this.pending;
  }
  async dispose(): Promise<void> {
    const drained = this.drain();
    this.disposed = true;
    this.battery.dispose();
    await drained;
  }
}
