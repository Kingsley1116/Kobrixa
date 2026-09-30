import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageService } from "./language.js";

// Run the actual worker entry, including project loading and the compiler.
// Node 24 strips types; the packaged Electron build uses bundled CommonJS.
describe("LanguageService background checks", () => {
  let root: string;
  let service: LanguageService;
  let workers: Worker[];
  let createWorker: ReturnType<typeof vi.fn<() => Worker>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kobrixa-language-"));
    await writeFile(path.join(root, "main.bp"), "LCD.Clear()\n");
    workers = [];
    createWorker = vi.fn(() => {
      const worker = new Worker(new URL("./language-worker.ts", import.meta.url), {
        execArgv: [],
      });
      workers.push(worker);
      return worker;
    });
    service = new LanguageService(
      {
        projectInput: (id) => {
          if (id !== "workspace") throw new Error("Unknown workspace.");
          return { inputPath: root, selectedEntry: "main.bp" };
        },
      },
      createWorker,
    );
  });

  afterEach(async () => {
    service.dispose();
    await Promise.all(workers.map((worker) => worker.terminate()));
    await rm(root, { recursive: true, force: true });
  });

  it("checks unsaved overlays and reuses an idle worker", async () => {
    expect(await service.diagnostics("workspace", { "main.bp": "Unknown.Do()\n" })).toEqual([
      expect.objectContaining({ code: "BP3001", file: "main.bp" }),
    ]);
    expect(await service.diagnostics("workspace", {})).toEqual([]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("keeps the main event loop responsive during a large check", async () => {
    await service.diagnostics("workspace", {}); // Warm the worker first.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const diagnostics = await service.diagnostics("workspace", {
        "main.bp": "LCD.Clear()\n".repeat(30000),
      });
      expect(diagnostics).toEqual([]);
      expect(ticks).toBeGreaterThan(2);
    } finally {
      clearInterval(timer);
    }
  });

  it("terminates obsolete work and checks the next revision in a new worker", async () => {
    await service.diagnostics("workspace", {});
    const obsolete = service.diagnostics("workspace", {
      "main.bp": "LCD.Clear()\n".repeat(30000),
    });
    const rejected = expect(obsolete).rejects.toThrow("Diagnostics cancelled");
    service.cancel();
    service.cancel();
    await rejected;
    expect(await service.diagnostics("workspace", { "main.bp": "Unknown.Do()\n" })).toEqual([
      expect.objectContaining({ code: "BP3001" }),
    ]);
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it("recovers after the worker exits unexpectedly", async () => {
    const pending = service.diagnostics("workspace", {});
    const rejected = expect(pending).rejects.toThrow("Diagnostics worker exited");
    await workers[0]!.terminate();
    await rejected;
    expect(await service.diagnostics("workspace", {})).toEqual([]);
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown workspaces without creating a worker and stops on disposal", async () => {
    await expect(service.diagnostics("unknown", {})).rejects.toThrow("Unknown workspace");
    expect(createWorker).not.toHaveBeenCalled();
    const pending = service.diagnostics("workspace", {});
    const rejected = expect(pending).rejects.toThrow("Diagnostics cancelled");
    service.dispose();
    await rejected;
    await expect(service.diagnostics("workspace", {})).rejects.toThrow("disposed");
  });
});
