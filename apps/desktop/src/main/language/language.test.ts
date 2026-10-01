import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { applyAnalysis, type LanguageSyncRequest } from "../../shared/language-sync.js";
import { CompletionService } from "./completion.js";
import type { CompletionSyncRequest } from "../../shared/completion-sync.js";
import { LanguageService } from "./language.js";

// Run the actual worker entry, including project loading and the compiler.
// Use the same bundled CommonJS entry as the packaged Electron build.
describe("LanguageService background checks", () => {
  let root: string;
  let workerRoot: string;
  beforeAll(async () => {
    workerRoot = await mkdtemp(path.join(tmpdir(), "kobrixa-language-worker-"));
    await build({
      entryPoints: [fileURLToPath(new URL("./language-worker.ts", import.meta.url))],
      outfile: path.join(workerRoot, "worker.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
    });
  });
  afterAll(async () => {
    await rm(workerRoot, { recursive: true, force: true });
  });
  let service: LanguageService;
  let workers: Worker[];
  let createWorker: ReturnType<typeof vi.fn<() => Worker>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "kobrixa-language-"));
    await writeFile(path.join(root, "main.bp"), "LCD.Clear()\n");
    workers = [];
    createWorker = vi.fn(() => {
      const worker = new Worker(path.join(workerRoot, "worker.cjs"), { execArgv: [] });
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

  it("analyzes unsaved include/import overlays and returns exact token ranges with diagnostics", async () => {
    const result = await service.analyze("workspace", {
      "main.bp": 'Include "config"\nImport "helper"\nresult = Double(shared)\n',
      "config.bpi": "shared = 2\n",
      "helper.bpm": "Function Double(in number value)\nReturn value * 2\nEndFunction\n",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.tokensByFile["main.bp"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          range: { startLine: 3, startColumn: 10, endLine: 3, endColumn: 16 },
        }),
      ]),
    );
    expect(result.tokensByFile["helper.bpm"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "parameter", modifiers: ["declaration"] }),
      ]),
    );
    const reference = result.index.occurrencesByFile["main.bp"]?.find(
      (item) => item.range.startLine === 3 && item.range.startColumn === 10,
    );
    expect(result.index.symbols[reference!.symbolId]).toMatchObject({
      name: "Double",
      type: "number",
      declaration: { file: "helper.bpm" },
    });
    expect(result.index.sources["config.bpi"]).toBe("shared = 2\n");
    const changed = await service.analyze("workspace", { "main.bp": "Unknown.Do()\n" });
    expect(changed.diagnostics[0]?.code).toBe("BP3001");
    expect(changed.tokensByFile["main.bp"]).toEqual([]);
    expect(changed.tokensByFile["helper.bpm"]).toBeUndefined();
    expect(changed.index.sources["helper.bpm"]).toBeUndefined();
    expect(Object.values(changed.index.symbols).some((symbol) => symbol.name === "Double")).toBe(
      false,
    );
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

  it("cancels obsolete work and reuses the worker for the next revision", async () => {
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
    expect(createWorker).toHaveBeenCalledTimes(1);
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

  it("synchronizes deltas through cancellation, file removal and worker restart", async () => {
    const initial: LanguageSyncRequest = {
      session: "test",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: {
        set: {
          "main.bp": 'Import "lib"\nWork()\n',
          "lib.bpm": "Sub Work()\nEndSub\n",
          "unrelated.bp": "value = 1\n",
        },
        removed: [],
      },
    };
    const first = await service.sync("workspace", initial);
    if (first.kind !== "result") throw new Error("resync");
    let accepted = applyAnalysis(undefined, first.patch);
    const messages = vi.spyOn(workers[0]!, "postMessage");
    const second = await service.sync("workspace", {
      ...initial,
      revision: 2,
      baseRevision: 1,
      analysisBase: accepted.version,
      overlays: {
        set: { "main.bp": initial.overlays.set["main.bp"] + "' changed\n" },
        removed: [],
      },
    });
    if (second.kind !== "result") throw new Error("resync");
    expect(Object.keys(second.patch.index.sources.set)).toEqual(["main.bp"]);
    expect(Object.keys(second.patch.tokensByFile.set)).toEqual([]);
    expect(Object.keys(second.patch.index.symbols.set)).toEqual([]);
    expect(Object.keys(messages.mock.calls[0]![0].sync.overlays.set)).toEqual(["main.bp"]);
    accepted = applyAnalysis(accepted, second.patch);
    const obsolete = service.sync("workspace", {
      ...initial,
      revision: 3,
      baseRevision: 2,
      analysisBase: accepted.version,
      overlays: { set: { "unrelated.bp": "latest = 3\n" }, removed: [] },
    });
    const rejection = expect(obsolete).rejects.toThrow("cancelled");
    service.cancel();
    await rejection;
    const latest = await service.sync("workspace", {
      ...initial,
      revision: 4,
      baseRevision: 3,
      analysisBase: accepted.version,
      overlays: {
        set: { "renamed.bpm": "Sub Work()\nEndSub\n", "main.bp": 'Import "renamed"\nWork()\n' },
        removed: ["lib.bpm"],
      },
    });
    if (latest.kind !== "result") throw new Error("resync");
    accepted = applyAnalysis(accepted, latest.patch);
    expect(accepted.analysis.index.sources["unrelated.bp"]).toBe("latest = 3\n");
    expect(accepted.analysis.index.sources["lib.bpm"]).toBeUndefined();
    expect(accepted.analysis.diagnostics).toEqual([]);
    expect(createWorker).toHaveBeenCalledTimes(1);
    await workers[0]!.terminate();
    const restarted = await service.sync("workspace", {
      ...initial,
      revision: 5,
      baseRevision: 4,
      analysisBase: accepted.version,
      overlays: { set: {}, removed: [] },
    });
    if (restarted.kind !== "result") throw new Error("resync");
    expect(restarted.patch.base).toBeNull();
    expect(applyAnalysis(accepted, restarted.patch).analysis).toEqual(accepted.analysis);
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(await service.sync("workspace", { ...initial, revision: 6, baseRevision: 1 })).toEqual({
      kind: "resync",
    });
  });

  it("runs completion independently, synchronizes edits and recovers from worker restarts", async () => {
    const completionWorkers: Worker[] = [];
    const completion = new CompletionService(
      { projectInput: () => ({ inputPath: root, selectedEntry: "main.bp" }) },
      () => {
        const worker = new Worker(path.join(workerRoot, "worker.cjs"), {
          execArgv: [],
          workerData: { completion: true },
        });
        completionWorkers.push(worker);
        return worker;
      },
    );
    const initial: CompletionSyncRequest = {
      session: "completion",
      revision: 1,
      baseRevision: null,
      refresh: true,
      updates: [
        {
          kind: "reset",
          file: "main.bp",
          document: { version: 1, text: 'Import "lib"\nshared = 1\n' },
        },
        {
          kind: "reset",
          file: "lib.bpm",
          document: {
            version: 1,
            text: "Function Copy(in number shared)\nlocalValue = @outside\nReturn shared\nEndFunction\n",
          },
        },
      ],
    };
    try {
      const first = await completion.sync("workspace", initial);
      if (first.kind !== "result") throw new Error("resync");
      expect(
        Object.values(first.index.symbols).some(
          (s) => s.name === "localValue" && s.scope === "local",
        ),
      ).toBe(true);
      expect(first.index).not.toHaveProperty("sources");
      const diagnostics = service.analyze("workspace", {
        "main.bp": "LCD.Clear()\n".repeat(30000),
      });
      const edited: CompletionSyncRequest = {
        ...initial,
        revision: 2,
        baseRevision: 1,
        refresh: false,
        updates: [
          {
            kind: "edit",
            file: "main.bp",
            before: 1,
            version: 2,
            changes: [
              { offset: 'Import "lib"\nshared = 1\n'.length, length: 0, text: "fresh = 2\n" },
            ],
          },
        ],
      };
      const second = await completion.sync("workspace", edited);
      if (second.kind !== "result") throw new Error("resync");
      expect(second.versions["main.bp"]).toBe(2);
      expect(Object.values(second.index.symbols).some((s) => s.name === "fresh")).toBe(true);
      service.cancel();
      await diagnostics.catch((error) => expect(String(error)).toContain("cancelled"));
      await completionWorkers[0]!.terminate();
      expect(
        await completion.sync("workspace", {
          ...edited,
          revision: 3,
          baseRevision: 2,
          updates: [],
        }),
      ).toEqual({ kind: "resync" });
      const restarted = await completion.sync("workspace", { ...initial, revision: 4 });
      expect(restarted.kind).toBe("result");
      expect(completionWorkers).toHaveLength(2);
      const switched = await completion.sync("other", {
        ...initial,
        session: "other",
        updates: [
          { kind: "reset", file: "main.bp", document: { version: 1, text: "different = 1" } },
        ],
      });
      if (switched.kind !== "result") throw new Error("resync");
      expect(Object.values(switched.index.symbols).map((s) => s.name)).toEqual(["different"]);
    } finally {
      completion.dispose();
      await Promise.all(completionWorkers.map((worker) => worker.terminate()));
    }
  });
});
