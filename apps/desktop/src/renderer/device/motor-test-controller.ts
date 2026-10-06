import type { KobrixaApi } from "../../shared/api.js";
import {
  motorTestActive,
  type MotorTestRef,
  type MotorTestRequest,
  type MotorTestState,
} from "../../shared/motor-test.js";

type MotorApi = Pick<
  KobrixaApi["device"],
  "startMotorTest" | "keepMotorTestAlive" | "stopMotorTest" | "motorTestState" | "onMotorTest"
>;
export type MotorTestOptions = Omit<MotorTestRequest, "sessionId" | "testId">;
export interface MotorTestSettings {
  power: string;
  seconds: string;
  degrees: string;
  direction: 1 | -1;
  brake: boolean;
  mode: MotorTestOptions["mode"];
}

/** The renderer owns user intent only; hardware scheduling belongs to the main process. */
export class MotorTestController {
  private state: MotorTestState = {
    phase: "idle",
    angle: null,
    displacement: null,
    elapsedMs: 0,
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private sessionId: string | undefined;
  private active = false;
  private revision = 0;
  private lifecycle = 0;
  private generation = 0;
  private stopRequested = false;
  private keepalive: ReturnType<typeof setInterval> | undefined;
  private keepalivePending = false;
  private stopping: Promise<MotorTestState> | undefined;
  private stoppingBrake = true;
  private settings = new Map<number, MotorTestSettings>();

  constructor(private api: MotorApi) {}
  getSnapshot = (): MotorTestState => this.state;
  getBusy = (): boolean => motorTestActive(this.state);
  getSettings(port: number): MotorTestSettings {
    return (
      this.settings.get(port) ?? {
        power: "20",
        seconds: "1",
        degrees: "90",
        direction: 1,
        brake: true,
        mode: "jog",
      }
    );
  }
  saveSettings(port: number, settings: MotorTestSettings): void {
    this.settings.set(port, { ...settings });
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(state: MotorTestState): void {
    this.state = state;
    this.revision++;
    if (!motorTestActive(state)) this.clearKeepalive();
    this.listeners.forEach((listener) => listener());
  }
  async initialize(): Promise<void> {
    if (this.unsubscribe) return;
    const lifecycle = ++this.lifecycle;
    this.unsubscribe = this.api.onMotorTest((state) => this.accept(state));
    const revision = this.revision;
    try {
      const state = await this.api.motorTestState();
      if (this.lifecycle === lifecycle && this.revision === revision && !this.state.request)
        this.accept(state);
    } catch {
      // A fresh start always revalidates device state in the main process.
    }
  }
  configure(sessionId: string | undefined, active: boolean): void {
    const changed = this.sessionId !== sessionId;
    this.sessionId = sessionId;
    this.active = active && !!sessionId;
    if ((changed || !this.active) && motorTestActive(this.state)) void this.stop();
  }
  private accept(state: MotorTestState): void {
    const current = this.state.request;
    if (current && state.request?.testId !== current.testId) return;
    if (current && state.request?.sessionId !== current.sessionId) return;
    if (!current && state.request && state.request.sessionId !== this.sessionId) return;
    if (this.stopRequested && (state.phase === "preparing" || state.phase === "running")) return;
    if (current && !motorTestActive(this.state) && motorTestActive(state)) return;
    if (state.updatedAt && this.state.updatedAt && state.updatedAt < this.state.updatedAt) return;
    this.update(state);
  }
  async start(options: MotorTestOptions): Promise<void> {
    if (!this.sessionId || !this.active || this.stopping || motorTestActive(this.state)) return;
    const generation = ++this.generation;
    this.stopRequested = false;
    const request: MotorTestRequest = {
      ...options,
      sessionId: this.sessionId,
      testId: crypto.randomUUID(),
    };
    this.update({ request, phase: "preparing", angle: null, displacement: null, elapsedMs: 0 });
    const revision = this.revision;
    // Invoke before enabling keepalive. A release may stop this id while start is pending.
    const pending = this.api.startMotorTest(request);
    if (request.mode === "jog") {
      this.keepalive = setInterval(() => {
        if (this.stopRequested || this.keepalivePending || !motorTestActive(this.state)) return;
        this.keepalivePending = true;
        void this.api
          .keepMotorTestAlive(reference(request))
          .catch(() => {
            if (generation === this.generation) void this.stop();
          })
          .finally(() => {
            this.keepalivePending = false;
          });
      }, 100);
    }
    try {
      const result = await pending;
      if (generation === this.generation && revision === this.revision) this.accept(result);
    } catch (error) {
      if (generation === this.generation && !this.stopRequested && motorTestActive(this.state)) {
        // A rejected IPC response does not prove that a hardware command was never sent.
        this.update({ ...this.state, phase: "unconfirmed", message: errorMessage(error) });
        await this.stop();
      }
    }
  }
  releaseJog(): Promise<MotorTestState> {
    if (this.state.request?.mode !== "jog") return Promise.resolve(this.state);
    return this.stop(this.state.request.brake);
  }
  stop(brake = true): Promise<MotorTestState> {
    this.clearKeepalive();
    const request = this.state.request;
    if (this.stopping) {
      if (!brake || this.stoppingBrake || !request) return this.stopping;
      // Forced stop upgrades a coasting release even while its first IPC call is pending.
      this.stoppingBrake = true;
      const generation = this.generation;
      const revision = this.revision;
      const preceding = this.stopping;
      const upgraded = Promise.all([preceding, this.api.stopMotorTest(reference(request), true)])
        .then(([, result]) => {
          if (generation === this.generation && revision === this.revision) this.acceptStop(result);
          return this.state;
        })
        .catch((error: unknown) => {
          if (generation === this.generation)
            this.update({ ...this.state, phase: "unconfirmed", message: errorMessage(error) });
          return this.state;
        })
        .finally(() => {
          if (this.stopping === upgraded) this.stopping = undefined;
        });
      this.stopping = upgraded;
      return upgraded;
    }
    if (!request || (!motorTestActive(this.state) && this.state.phase !== "unconfirmed"))
      return Promise.resolve(this.state);
    const generation = this.generation;
    this.stopRequested = true;
    this.stoppingBrake = brake;
    this.update({ ...this.state, phase: "stopping" });
    const revision = this.revision;
    const stopping = this.api
      .stopMotorTest(reference(request), brake)
      .then((result) => {
        if (generation === this.generation && revision === this.revision) this.acceptStop(result);
        return this.state;
      })
      .catch((error: unknown) => {
        if (generation === this.generation) {
          this.update({ ...this.state, phase: "unconfirmed", message: errorMessage(error) });
        }
        return this.state;
      })
      .finally(() => {
        if (this.stopping === stopping) this.stopping = undefined;
      });
    this.stopping = stopping;
    return stopping;
  }
  private acceptStop(result: MotorTestState): void {
    const request = this.state.request;
    if (
      result.request?.testId !== request?.testId ||
      result.request?.sessionId !== request?.sessionId
    ) {
      this.update({
        ...this.state,
        phase: "unconfirmed",
        message: this.state.message || "Motor test ownership could not be confirmed.",
      });
    } else this.accept(result);
  }
  private clearKeepalive(): void {
    if (this.keepalive !== undefined) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }
  async drain(): Promise<void> {
    this.active = false;
    const state = await this.stop();
    if (motorTestActive(state) || state.phase === "unconfirmed")
      throw new Error(state.message || "Motor stop could not be confirmed.");
  }
  async dispose(): Promise<void> {
    this.active = false;
    this.lifecycle++;
    // React may reinitialize this controller before stop settles (StrictMode/remount).
    // Detach synchronously so old cleanup cannot remove the new subscription.
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.stop();
  }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reference({ sessionId, testId }: MotorTestRef): MotorTestRef {
  return { sessionId, testId };
}
