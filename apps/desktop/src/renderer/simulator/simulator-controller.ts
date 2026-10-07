import type {
  PreparedSimulation,
  SimulationCommand,
  SimulationResponse,
  SimulationScene,
  SimulationSnapshot,
} from "../../shared/simulator.js";

export interface SimulatorState {
  snapshot: SimulationSnapshot | null;
  preparing: boolean;
  error: string | null;
}
export interface SimulatorWorker {
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(command: SimulationCommand): void;
  terminate(): void;
}
/** Owns compilation generations and worker lifetime, so a late build can never start stale code. */
export class SimulatorController {
  private state: SimulatorState = { snapshot: null, preparing: false, error: null };
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
    this.update({ snapshot: null, preparing: false, error: null });
  }
  getSnapshot = (): SimulatorState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<SimulatorState>): void {
    this.state = { ...this.state, ...patch };
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
    this.update({ snapshot: null, preparing: false, error: null });
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
  start(): void {
    if (this.disposed || !this.active || this.state.preparing) return;
    if (
      this.worker &&
      !this.state.error &&
      ["ready", "paused"].includes(this.state.snapshot?.status ?? "")
    )
      this.send({ type: "run" });
    else void this.recompile(true);
  }
  async recompile(run = false): Promise<void> {
    if (this.disposed || !this.active) return;
    this.abandonPreparation();
    const generation = ++this.generation;
    this.pendingPreparation = true;
    const scene = structuredClone(this.scene);
    this.terminate();
    this.update({ snapshot: null, preparing: true, error: null });
    try {
      const prepared = await this.prepare(scene);
      if (this.disposed || generation !== this.generation || !this.active) return;
      this.pendingPreparation = false;
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
      if (run) instance.postMessage({ type: "run" });
      this.update({ preparing: false });
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
  stop(): void {
    this.abandonPreparation();
    this.send({ type: "stop" });
  }
  reset(): void {
    this.abandonPreparation();
    if (this.worker) {
      this.update({ error: null });
      this.send({ type: "reset" });
    } else this.update({ snapshot: null, error: null });
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
