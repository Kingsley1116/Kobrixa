import type {
  PortWarning,
  PreparedSimulation,
  SimulationCommand,
  SimulationResponse,
  SimulationScene,
  SimulationSnapshot,
} from "../../shared/simulator.js";
import { checkRobotPorts } from "../../simulation/port-check.js";

export interface SimulatorState {
  snapshot: SimulationSnapshot | null;
  preparing: boolean;
  error: string | null;
  /** The loaded program was built from sources that have since changed. */
  stale: boolean;
  warnings: PortWarning[];
}
export interface SimulatorWorker {
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(command: SimulationCommand): void;
  terminate(): void;
}
/** Owns compilation generations and worker lifetime, so a late build can never start stale code. */
export class SimulatorController {
  private state: SimulatorState = {
    snapshot: null,
    preparing: false,
    error: null,
    stale: false,
    warnings: [],
  };
  private readonly listeners = new Set<() => void>();
  private worker: SimulatorWorker | null = null;
  private generation = 0;
  private pendingPreparation = false;
  private disposed = false;
  private active = true;
  private scene: SimulationScene;
  private sceneKey: string;
  private selected: string;
  private speed = 1;
  private revision: string | null = null;
  private preparedRevision: string | null = null;
  constructor(
    scene: SimulationScene,
    private readonly prepare: (scene: SimulationScene) => Promise<PreparedSimulation>,
    private readonly createWorker: () => SimulatorWorker = () =>
      new Worker(new URL("../../simulation/worker.ts", import.meta.url), { type: "module" }),
    private readonly cancelPrepare?: () => void,
  ) {
    this.scene = scene;
    this.sceneKey = JSON.stringify(scene);
    this.selected = scene.robots[0]?.id ?? "";
  }
  /** React StrictMode replays mount effects on the same retained controller. */
  attach(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.update({ snapshot: null, preparing: false, error: null, warnings: [] });
  }
  getSnapshot = (): SimulatorState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<SimulatorState>): void {
    const next = { ...this.state, ...patch };
    next.stale = next.snapshot !== null && this.preparedRevision !== this.revision;
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  private terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
  private abandonPreparation(): void {
    if (!this.pendingPreparation) return;
    this.pendingPreparation = false;
    this.generation++;
    this.update({ preparing: false });
    // Local generations still prevent stale starts if backend cancellation is unavailable.
    try {
      this.cancelPrepare?.();
    } catch {
      /* Best-effort backend cancellation. */
    }
  }
  setScene(scene: SimulationScene): void {
    const key = JSON.stringify(scene);
    this.scene = scene;
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    this.abandonPreparation();
    this.generation++;
    this.terminate();
    this.update({ snapshot: null, preparing: false, error: null, warnings: [] });
  }
  setSourceRevision(revision: string): void {
    if (revision === this.revision) return;
    this.revision = revision;
    this.update({});
  }
  select(robotId: string): void {
    this.selected = robotId;
    this.send({ type: "select", robotId });
  }
  setSpeed(value: number): void {
    this.speed = value;
    this.send({ type: "speed", value });
  }
  send(command: SimulationCommand): void {
    if (!this.disposed) this.worker?.postMessage(command);
  }
  private canResume(): boolean {
    return (
      !!this.worker &&
      !this.state.error &&
      !this.state.stale &&
      ["ready", "paused"].includes(this.state.snapshot?.status ?? "")
    );
  }
  /** Resumes the loaded program, or builds the current sources first when there is none or it is stale. */
  start(): void {
    if (this.disposed || !this.active || this.state.preparing) return;
    if (this.canResume()) this.send({ type: "run" });
    else void this.recompile("run");
  }
  step(): void {
    if (this.disposed || !this.active || this.state.preparing) return;
    if (this.canResume()) this.send({ type: "step" });
    else void this.recompile("step");
  }
  async recompile(after: "none" | "run" | "step" = "none"): Promise<void> {
    if (this.disposed || !this.active) return;
    this.abandonPreparation();
    const generation = ++this.generation,
      revision = this.revision;
    this.pendingPreparation = true;
    const scene = structuredClone(this.scene);
    this.terminate();
    this.update({ snapshot: null, preparing: true, error: null, warnings: [] });
    try {
      const prepared = await this.prepare(scene);
      if (this.disposed || generation !== this.generation || !this.active) return;
      this.pendingPreparation = false;
      this.preparedRevision = revision;
      const instance = this.createWorker();
      this.worker = instance;
      instance.onmessage = (event) => {
        if (this.disposed || generation !== this.generation || this.worker !== instance) return;
        if (event.data.type === "snapshot")
          this.update({ snapshot: event.data.snapshot, preparing: false });
        else {
          instance.postMessage({ type: "pause" });
          this.update({ preparing: false, error: event.data.message });
        }
      };
      instance.onerror = (event) => {
        if (this.disposed || generation !== this.generation || this.worker !== instance) return;
        this.terminate();
        this.update({
          preparing: false,
          error: event.message || "The simulation worker could not start.",
        });
      };
      instance.postMessage({ type: "load", scene, prepared });
      instance.postMessage({ type: "select", robotId: this.selected });
      instance.postMessage({ type: "speed", value: this.speed });
      if (after !== "none") instance.postMessage({ type: after });
      this.update({ preparing: false, warnings: checkRobotPorts(scene, prepared) });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.pendingPreparation = false;
      this.terminate();
      this.update({
        preparing: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  pause(): void {
    this.abandonPreparation();
    this.send({ type: "pause" });
  }
  /** Discards the loaded program so the next Start always builds the current sources. */
  reset(): void {
    this.abandonPreparation();
    this.generation++;
    this.terminate();
    this.update({ snapshot: null, preparing: false, error: null, warnings: [] });
  }
  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.pause();
      this.send({ type: "buttons", robotId: this.selected, buttons: [] });
    }
  }
  dispose(): void {
    this.abandonPreparation();
    this.disposed = true;
    this.generation++;
    this.terminate();
    this.listeners.clear();
  }
}
