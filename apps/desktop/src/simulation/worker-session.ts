import {
  SIMULATION_SPEEDS,
  SIMULATION_TICK_MS,
  type PreparedSimulation,
  type SimulationCommand,
  type SimulationResponse,
  type SimulationScene,
} from "../shared/simulator.js";
import { SimulationWorld } from "./world.js";

/** Wall-clock pacing only; every call into the world is an integral fixed tick. */
export class SimulationWorkerSession {
  private world: SimulationWorld | undefined;
  private initial: { scene: SimulationScene; prepared: PreparedSimulation } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private speed = 1;
  private accumulator = 0;
  private lastTime = 0;
  constructor(
    private readonly emit: (response: SimulationResponse) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  receive(command: SimulationCommand): void {
    try {
      switch (command.type) {
        case "load": {
          this.cancel();
          this.world = undefined;
          this.initial = undefined;
          this.initial = structuredClone({ scene: command.scene, prepared: command.prepared });
          this.world = new SimulationWorld(this.initial.scene, this.initial.prepared);
          this.accumulator = 0;
          break;
        }
        case "reset": {
          this.cancel();
          const selected = this.world?.selectedRobotId;
          if (this.initial)
            this.world = new SimulationWorld(this.initial.scene, this.initial.prepared);
          if (selected) this.world?.select(selected);
          this.accumulator = 0;
          break;
        }
        case "run":
          this.world?.run();
          this.lastTime = this.now();
          break;
        case "pause":
          this.cancel();
          this.world?.pause();
          break;
        case "stop":
          this.cancel();
          this.world?.stop();
          this.accumulator = 0;
          break;
        case "step":
          this.cancel();
          this.world?.pause();
          this.world?.step();
          break;
        case "speed":
          if (!SIMULATION_SPEEDS.some((speed) => speed === command.value))
            throw new Error("Invalid simulation speed.");
          this.speed = command.value;
          this.lastTime = this.now();
          break;
        case "select":
          this.world?.select(command.robotId);
          break;
        case "buttons":
          this.world?.buttons(command.robotId, command.buttons);
          break;
      }
      this.publish();
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
  }

  dispose(): void {
    this.cancel();
    this.world?.stop();
    this.world = undefined;
    this.initial = undefined;
  }
  private publish(): void {
    if (this.world) this.emit({ type: "snapshot", snapshot: this.world.snapshot() });
  }
  private schedule(): void {
    if (this.timer !== undefined || this.world?.status !== "running") return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        const time = this.now();
        // Resume after OS sleep without replaying minutes of stale user intent.
        this.accumulator += Math.min(100, Math.max(0, time - this.lastTime)) * this.speed;
        this.lastTime = time;
        const ticks = Math.min(20, Math.floor(this.accumulator / SIMULATION_TICK_MS));
        const started = this.now();
        for (let tick = 0; tick < ticks; tick++) {
          this.world?.advance(1);
          this.accumulator -= SIMULATION_TICK_MS;
          // Yield between shared ticks so pause/stop stays responsive even for heavy programs.
          if (this.world?.status !== "running" || this.now() - started >= 12) break;
        }
        this.publish();
        this.schedule();
      } catch (error) {
        this.fail(error);
      }
    }, 16);
  }
  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private fail(error: unknown): void {
    this.cancel();
    this.world?.pause();
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
