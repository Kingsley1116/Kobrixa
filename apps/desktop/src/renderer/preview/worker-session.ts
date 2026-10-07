import { VirtualDevice } from "../../preview/virtual-device.js";
import { PreviewRuntime, type PreviewSnapshot } from "../../preview/runtime.js";
import type { PreviewCommand, PreviewResponse } from "./protocol.js";
import { previewSpeeds } from "./protocol.js";

/** Each tick has a fixed instruction ceiling and yields back to the worker event loop. */
export class PreviewWorkerSession {
  private runtime: PreviewRuntime | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private speed = 1;
  private lastTick = 0;
  private running = false;
  constructor(private readonly emit: (message: PreviewResponse) => void) {}

  receive(command: PreviewCommand): void {
    try {
      let snapshot: PreviewSnapshot | undefined;
      if (command.type === "load") {
        this.cancelTick();
        this.runtime = new PreviewRuntime(
          command.ir,
          new VirtualDevice({
            ...(command.files ? { files: command.files } : {}),
            ...(command.ir.program.runtimeDirectory
              ? { runtimeDirectory: command.ir.program.runtimeDirectory }
              : {}),
          }),
        );
        if (command.inputs) snapshot = this.runtime.setInputs(command.inputs);
      } else if (command.type === "speed") {
        if (previewSpeeds.some((speed) => speed === command.value)) this.speed = command.value;
      } else if (this.runtime) {
        switch (command.type) {
          case "run":
            snapshot = this.runtime.resume();
            this.lastTick = performance.now();
            break;
          case "pause":
            this.cancelTick();
            snapshot = this.runtime.pause();
            break;
          case "step":
            this.cancelTick();
            snapshot = this.runtime.step();
            break;
          case "stop":
            this.cancelTick();
            snapshot = this.runtime.stop();
            break;
          case "inputs":
            snapshot = this.runtime.setInputs(command.inputs);
            break;
        }
      }
      this.publish(snapshot);
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
  }

  dispose(): void {
    this.cancelTick();
    this.runtime = undefined;
    this.running = false;
  }

  private publish(snapshot = this.runtime?.getSnapshot()): void {
    if (!snapshot) return;
    this.running = snapshot.status === "running";
    this.emit({ type: "snapshot", snapshot });
  }

  private schedule(): void {
    if (this.timer !== undefined || !this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.runtime) return;
      try {
        const now = performance.now();
        // Do not fast-forward a robot by minutes after the OS suspends the application.
        const elapsed = Math.min(100, Math.max(0, now - this.lastTick)) * this.speed;
        this.lastTick = now;
        this.publish(this.runtime.runSlice(2_000, elapsed));
        this.schedule();
      } catch (error) {
        this.fail(error);
      }
    }, 32);
  }

  private cancelTick(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fail(error: unknown): void {
    this.cancelTick();
    this.runtime?.pause();
    this.running = false;
    this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
