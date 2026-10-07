import { describe, expect, it, vi } from "vitest";
import type {
  PreparedSimulation,
  SimulationCommand,
  SimulationResponse,
} from "../../shared/simulator.js";
import { createDefaultScene } from "../../simulation/scene.js";
import { SimulatorController, type SimulatorWorker } from "./simulator-controller.js";

class WorkerStub implements SimulatorWorker {
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  commands: SimulationCommand[] = [];
  terminated = false;
  postMessage(command: SimulationCommand) {
    this.commands.push(command);
  }
  terminate() {
    this.terminated = true;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const prepared: PreparedSimulation = { programs: {} };

describe("simulator compilation and worker lifecycle", () => {
  it("discards a preparation result after scene changes and compiles the new immutable scene", async () => {
    const first = deferred<PreparedSimulation>(),
      second = deferred<PreparedSimulation>();
    const prepare = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const workers: WorkerStub[] = [],
      create = () => {
        const worker = new WorkerStub();
        workers.push(worker);
        return worker;
      };
    const scene = createDefaultScene(),
      controller = new SimulatorController(scene, prepare, create);
    const pending = controller.recompile(true);
    const changed = { ...scene, seed: 42 };
    controller.setScene(changed);
    first.resolve(prepared);
    await pending;
    expect(workers).toHaveLength(0);
    const next = controller.recompile(true);
    second.resolve(prepared);
    await next;
    expect(workers).toHaveLength(1);
    expect(workers[0]!.commands[0]).toMatchObject({ type: "load", scene: { seed: 42 } });
    expect(workers[0]!.commands.at(-1)).toEqual({ type: "run" });
    expect(prepare.mock.calls[1]![0]).not.toBe(changed);
    controller.dispose();
    expect(workers[0]!.terminated).toBe(true);
  });

  it("terminates the old program before rebuilding and never starts it after compilation fails", async () => {
    const worker = new WorkerStub();
    const prepare = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockRejectedValue(new Error("compile failed"));
    const factory = vi.fn(() => worker),
      controller = new SimulatorController(createDefaultScene(), prepare, factory);
    await controller.recompile();
    await controller.recompile(true);
    expect(worker.terminated).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      error: "compile failed",
      snapshot: null,
      preparing: false,
    });
    expect(worker.commands.some((command) => command.type === "run")).toBe(false);
    expect(factory).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it.each(["pause", "stop", "reset", "hidden", "dispose", "scene"] as const)(
    "ignores late compilation after %s",
    async (action) => {
      const pending = deferred<PreparedSimulation>(),
        factory = vi.fn(() => new WorkerStub()),
        cancel = vi.fn();
      const controller = new SimulatorController(
        createDefaultScene(),
        () => pending.promise,
        factory,
        cancel,
      );
      const work = controller.recompile(true);
      if (action === "hidden") controller.setActive(false);
      else if (action === "scene") controller.setScene({ ...createDefaultScene(), seed: 123 });
      else controller[action]();
      pending.resolve(prepared);
      await work;
      expect(factory).not.toHaveBeenCalled();
      if (action !== "dispose") expect(controller.getSnapshot().preparing).toBe(false);
      controller.dispose();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("cancels each superseded pending preparation once but does not cancel completed work", async () => {
    const first = deferred<PreparedSimulation>(),
      second = deferred<PreparedSimulation>(),
      cancel = vi.fn();
    const prepare = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const factory = vi.fn(() => new WorkerStub());
    const controller = new SimulatorController(createDefaultScene(), prepare, factory, cancel);
    const old = controller.recompile(true);
    const current = controller.recompile();
    expect(cancel).toHaveBeenCalledOnce();
    first.resolve(prepared);
    await old;
    expect(factory).not.toHaveBeenCalled();
    second.resolve(prepared);
    await current;
    controller.pause();
    controller.stop();
    controller.setScene({ ...createDefaultScene(), seed: 888 });
    controller.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("pauses and releases input when hidden, and ignores messages from replaced workers", async () => {
    const workers: WorkerStub[] = [],
      controller = new SimulatorController(
        createDefaultScene(),
        async () => prepared,
        () => {
          const worker = new WorkerStub();
          workers.push(worker);
          return worker;
        },
      );
    controller.select("A1");
    controller.setSpeed(2);
    await controller.recompile(true);
    controller.setActive(false);
    expect(workers[0]!.commands.slice(-2)).toEqual([
      { type: "pause" },
      { type: "buttons", robotId: "A1", buttons: [] },
    ]);
    controller.start();
    expect(workers[0]!.commands.at(-1)?.type).toBe("buttons");
    controller.setActive(true);
    await controller.recompile();
    workers[0]!.onmessage?.({
      data: { type: "error", message: "stale error" },
    } as MessageEvent<SimulationResponse>);
    expect(controller.getSnapshot().error).toBeNull();
    expect(workers[1]!.commands).toContainEqual({ type: "speed", value: 2 });
    controller.dispose();
  });
});
