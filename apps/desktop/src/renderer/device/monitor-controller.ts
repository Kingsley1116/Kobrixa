import type { DeviceInputModes, DeviceMonitorSnapshot, MonitorInput } from "@kobrixa/device";
import type { KobrixaApi, MonitorResult } from "../../shared/api.js";

type MonitorApi = Pick<KobrixaApi["device"], "monitor" | "inputModes" | "setInputMode">;
export interface MonitorState {
  sessionId: string | undefined;
  active: boolean;
  status: "paused" | "waiting" | "live" | "error";
  snapshot: DeviceMonitorSnapshot | undefined;
  modes: Record<number, DeviceInputModes>;
  loadingPort: number | undefined;
  switchingPort: number | undefined;
  error: string | undefined;
  modeError: string | undefined;
}

/** Owns sampling separately from the editor. Stopping never cancels an EV3 exchange. */
export class MonitorController {
  private state: MonitorState = {
    sessionId: undefined,
    active: false,
    status: "paused",
    snapshot: undefined,
    modes: {},
    loadingPort: undefined,
    switchingPort: undefined,
    error: undefined,
    modeError: undefined,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;

  constructor(private api: MonitorApi) {}
  getSnapshot = (): MonitorState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<MonitorState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  configure(sessionId: string | undefined, active: boolean): void {
    active = active && !!sessionId;
    if (sessionId === this.state.sessionId && active === this.state.active) return;
    const changedSession = sessionId !== this.state.sessionId;
    this.generation++;
    this.clearTimer();
    this.update({
      sessionId,
      active,
      status: active ? "waiting" : "paused",
      loadingPort: undefined,
      switchingPort: undefined,
      ...(changedSession
        ? {
            modes: {},
            snapshot: sessionId ? undefined : this.state.snapshot,
            error: undefined,
            modeError: undefined,
          }
        : {}),
    });
    if (active && !this.pending) this.poll();
  }
  /** Update installation waits for sampling AND mode queries/switches to finish. */
  async drain(): Promise<void> {
    this.configure(this.state.sessionId, false);
    while (this.pending) await this.pending;
  }
  private current(generation: number): boolean {
    return generation === this.generation && this.state.active && !!this.state.sessionId;
  }
  private schedule(): void {
    this.clearTimer();
    if (this.state.active && this.state.sessionId) this.timer = setTimeout(() => this.poll(), 500);
  }
  private track(work: () => Promise<void>): Promise<void> {
    const preceding = this.pending;
    const tracked = Promise.resolve()
      .then(async () => {
        await preceding;
        await work();
      })
      .finally(() => {
        if (this.pending === tracked) {
          this.pending = undefined;
          this.schedule();
        }
      });
    this.pending = tracked;
    return tracked;
  }
  private accept(snapshot: DeviceMonitorSnapshot): void {
    const modes = { ...this.state.modes };
    for (const port of Object.keys(modes).map(Number)) {
      const input = snapshot.inputs.find((value) => value.port === port);
      if (!input || input.state !== "ready" || input.type !== modes[port]?.type) delete modes[port];
    }
    this.update({ snapshot, modes, status: "live", error: undefined });
  }
  private poll(): void {
    this.clearTimer();
    const sessionId = this.state.sessionId;
    if (!this.state.active || !sessionId || this.pending) return;
    const generation = this.generation;
    void this.track(async () => {
      if (!this.current(generation)) return;
      try {
        const result = await this.api.monitor(sessionId);
        if (!this.current(generation)) return;
        if (result.status === "ok") this.accept(result.value);
        else if (result.status === "busy") this.update({ status: "waiting" });
        else this.update({ status: "error", error: result.message });
      } catch (error) {
        if (this.current(generation)) this.update({ status: "error", error: errorMessage(error) });
      }
    });
  }
  canSwitch(port: number): boolean {
    const input = this.state.snapshot?.inputs.find((value) => value.port === port);
    return !!(
      this.state.active &&
      this.state.sessionId &&
      this.state.status === "live" &&
      this.state.snapshot?.program.status === "stopped" &&
      input?.switchable &&
      input.state === "ready" &&
      this.state.loadingPort === undefined &&
      this.state.switchingPort === undefined
    );
  }
  loadModes(port: number): Promise<void> {
    const input = this.state.snapshot?.inputs.find((value) => value.port === port);
    if (!input || !this.canSwitch(port) || this.state.modes[port]?.type === input.type)
      return Promise.resolve();
    return this.modeRequest(input, undefined);
  }
  setMode(port: number, mode: number): Promise<void> {
    const input = this.state.snapshot?.inputs.find((value) => value.port === port);
    if (
      !input ||
      !this.canSwitch(port) ||
      input.mode === mode ||
      !this.state.modes[port]?.modes.some((value) => value.mode === mode)
    )
      return Promise.resolve();
    return this.modeRequest(input, mode);
  }
  private modeRequest(input: MonitorInput, mode: number | undefined): Promise<void> {
    const generation = this.generation;
    const sessionId = this.state.sessionId!;
    this.clearTimer();
    this.update({
      modeError: undefined,
      loadingPort: mode === undefined ? input.port : undefined,
      switchingPort: mode === undefined ? undefined : input.port,
    });
    return this.track(async () => {
      if (!this.current(generation)) return;
      try {
        const current = this.state.snapshot?.inputs.find((value) => value.port === input.port);
        if (
          current?.type !== input.type ||
          current.state !== "ready" ||
          this.state.status !== "live" ||
          this.state.snapshot?.program.status !== "stopped"
        )
          return;
        const result: MonitorResult<DeviceMonitorSnapshot | DeviceInputModes> =
          mode === undefined
            ? await this.api.inputModes(sessionId, input.port, input.type)
            : await this.api.setInputMode(sessionId, input.port, input.type, mode);
        if (!this.current(generation)) return;
        if (result.status === "busy") this.update({ status: "waiting" });
        else if (result.status === "error")
          this.update({ modeError: result.message, status: "waiting" });
        else if ("inputs" in result.value) this.accept(result.value);
        else if (result.value.port === input.port && result.value.type === input.type)
          this.update({ modes: { ...this.state.modes, [input.port]: result.value } });
      } catch (error) {
        if (this.current(generation))
          this.update({ modeError: errorMessage(error), status: "waiting" });
      } finally {
        if (this.current(generation))
          this.update({ loadingPort: undefined, switchingPort: undefined });
      }
    });
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
