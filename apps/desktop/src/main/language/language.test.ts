import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import {
  applyAnalysis,
  emptyAnalysis,
  type LanguageSyncRequest,
} from "../../shared/language-sync.js";
import type { CompletionSyncRequest } from "../../shared/completion-sync.js";
import type { LanguageFeatureRequest } from "../../shared/language-query.js";
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
    await build({
      stdin: {
        resolveDir: path.dirname(fileURLToPath(import.meta.url)),
        contents: `
          import "./language-worker.ts";
          import { workerData } from "node:worker_threads";
          import { BasicPlusProjectAnalyzer } from "@kobrixa/basic-plus";
          import { BuildError } from "@kobrixa/compiler";
          const analyze = BasicPlusProjectAnalyzer.prototype.analyze;
          BasicPlusProjectAnalyzer.prototype.analyze = function (...args) {
            if (workerData?.analyzerFailure === "build")
              throw new BuildError("BUILD1006", "Analyzer failure.");
            if (workerData?.analyzerFailure === "lookalike")
              throw Object.assign(new Error("Analyzer failure."), { code: "BUILD1007" });
            const result = analyze.apply(this, args);
            return {
              ...result,
              diagnostics: result.diagnostics.map((item) => ({ ...item, source: "acme.forged" })),
            };
          };
        `,
      },
      outfile: path.join(workerRoot, "injected-worker.cjs"),
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
          if (id !== "workspace" && id !== "other") throw new Error("Unknown workspace.");
          return { inputPath: root, selectedEntry: "main.bp" };
        },
      },
      createWorker,
      undefined,
      () => {
        const worker = new Worker(path.join(workerRoot, "worker.cjs"), {
          execArgv: [],
          workerData: { completion: true },
        });
        workers.push(worker);
        return worker;
      },
    );
  });

  afterEach(async () => {
    service.dispose();
    await Promise.all(workers.map((worker) => worker.terminate()));
    await rm(root, { recursive: true, force: true });
  });

  function useInjectedAnalyzer(analyzerFailure?: "build" | "lookalike") {
    createWorker.mockImplementation(() => {
      const worker = new Worker(path.join(workerRoot, "injected-worker.cjs"), {
        execArgv: [],
        workerData: { analyzerFailure },
      });
      workers.push(worker);
      return worker;
    });
  }

  // Faults must happen after dispatch, now that status reads are asynchronous.
  function onNextDispatch(action: (worker: Worker) => void) {
    const create = createWorker.getMockImplementation()!;
    createWorker.mockImplementationOnce(() => {
      const worker = create();
      const post = worker.postMessage.bind(worker);
      vi.spyOn(worker, "postMessage").mockImplementationOnce((message) => {
        post(message);
        action(worker);
      });
      return worker;
    });
  }

  it("checks unsaved overlays and reuses an idle worker", async () => {
    expect(await service.diagnostics("workspace", { "main.bp": "Unknown.Do()\n" })).toEqual([
      expect.objectContaining({ code: "BP3001", file: "main.bp" }),
    ]);
    expect(await service.diagnostics("workspace", {})).toEqual([]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("publishes analysis diagnostics as Basic Plus and loader diagnostics as core", async () => {
    expect(await service.diagnostics("workspace", { "main.bp": "Unknown.Do()\n" })).toEqual([
      expect.objectContaining({ code: "BP3001", source: "kobrixa.basic-plus" }),
    ]);
    await writeFile(path.join(root, "kobrixa.json"), "{");
    const loader = await service.diagnostics("workspace", {});
    expect(loader.length).toBeGreaterThan(0);
    expect(loader.every((item) => item.source === "kobrixa.core")).toBe(true);
  });

  it("publishes only a core BUILD1007 analysis when the analyzer forges a source", async () => {
    useInjectedAnalyzer();
    const analysis = await service.analyze("workspace", { "main.bp": "Unknown.Do()\n" });
    expect(analysis).toEqual({
      ...emptyAnalysis(),
      diagnostics: [
        expect.objectContaining({
          code: "BUILD1007",
          source: "kobrixa.core",
          severity: "error",
          message:
            "A compiler provider returned diagnostics with a source; Kobrixa assigns diagnostic sources.",
        }),
      ],
    });
  });

  it.each(["build", "lookalike"] as const)(
    "still rejects other analyzer errors (%s)",
    async (failure) => {
      useInjectedAnalyzer(failure);
      await expect(service.analyze("workspace", {})).rejects.toThrow(
        failure === "build" ? "BUILD1006: Analyzer failure." : "Analyzer failure.",
      );
    },
  );

  it("returns stale when the requested source differs from the published diagnostic", async () => {
    const request: LanguageSyncRequest = {
      epoch: (await service.status("workspace")).epoch,
      session: "source-test",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: { "main.bp": "LCD.Clear( ' comment\n" }, removed: [] },
    };
    const reply = await service.sync("workspace", request);
    if (reply.kind !== "result") throw new Error("resync");
    const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics.find(
      (d) => d.code === "BP1043",
    )!;
    expect(diagnostic.source).toBe("kobrixa.basic-plus");
    const query = {
      epoch: (await service.status("workspace")).epoch,
      requestId: "source-query",
      session: request.session,
      revision: request.revision,
      analysisVersion: reply.patch.version,
      file: "main.bp",
      diagnostic,
    };
    expect(
      await service.quickFixes("workspace", {
        ...query,
        requestId: "forged",
        diagnostic: { ...diagnostic, source: "acme.x" },
      }),
    ).toEqual({ kind: "stale", epoch: (await service.status("workspace")).epoch });
    expect(await service.quickFixes("workspace", query)).toMatchObject({ kind: "result" });
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
      signature: "Double(in number value): number",
      location: { file: "helper.bpm" },
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

  it.each([new Error("worker failure"), "worker failure"])(
    "recovers from worker error %s",
    async (error) => {
      onNextDispatch((worker) => worker.emit("error", error));
      const pending = service.diagnostics("workspace", {});
      const rejected = expect(pending).rejects.toThrow("worker failure");
      await rejected;
      expect(await service.diagnostics("workspace", {})).toEqual([]);
      expect(createWorker).toHaveBeenCalledTimes(2);
    },
  );

  it("recovers after the worker exits unexpectedly", async () => {
    onNextDispatch((worker) => {
      void worker.terminate();
    });
    const pending = service.diagnostics("workspace", {});
    const rejected = expect(pending).rejects.toThrow("Diagnostics worker exited");
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
      epoch: (await service.status("workspace")).epoch,
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
    const post = workers[0]!.postMessage.bind(workers[0]!);
    messages.mockImplementationOnce((message) => {
      post(message);
      service.cancel();
    });
    const obsolete = service.sync("workspace", {
      ...initial,
      revision: 3,
      baseRevision: 2,
      analysisBase: accepted.version,
      overlays: { set: { "unrelated.bp": "latest = 3\n" }, removed: [] },
    });
    const rejection = expect(obsolete).rejects.toThrow("cancelled");
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
      epoch: (await service.status("workspace")).epoch,
      revision: 5,
      baseRevision: null,
      analysisBase: accepted.version,
      overlays: { set: accepted.analysis.index.sources, removed: [] },
    });
    if (restarted.kind !== "result") throw new Error("resync");
    expect(restarted.patch.base).toBeNull();
    expect(applyAnalysis(accepted, restarted.patch).analysis).toEqual(accepted.analysis);
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(await service.sync("workspace", { ...initial, revision: 6, baseRevision: 1 })).toEqual({
      kind: "resync",
      epoch: (await service.status("workspace")).epoch,
    });
  });

  it("resolves cached quick fixes only for the accepted workspace and analysis revision", async () => {
    const request: LanguageSyncRequest = {
      epoch: (await service.status("workspace")).epoch,
      session: "fix-test",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: { "main.bp": "LCD.Clear( ' comment\n" }, removed: [] },
    };
    const reply = await service.sync("workspace", request);
    if (reply.kind !== "result") throw new Error("resync");
    const analysis = applyAnalysis(undefined, reply.patch).analysis;
    const diagnostic = analysis.diagnostics.find((d) => d.code === "BP1043")!;
    const query = {
      epoch: (await service.status("workspace")).epoch,
      requestId: "fix-query",
      session: request.session,
      revision: request.revision,
      analysisVersion: reply.patch.version,
      file: "main.bp",
      diagnostic,
    };
    const first = await service.quickFixes("workspace", query);
    expect(first).toMatchObject({
      kind: "result",
      fixes: [{ title: { en: "Insert closing parenthesis )" }, edits: [{ newText: ")" }] }],
    });
    expect(await service.quickFixes("workspace", query)).toEqual(first);
    expect(
      await service.quickFixes("workspace", {
        ...query,
        analysisVersion: query.analysisVersion + 100,
      }),
    ).toEqual({ kind: "stale", epoch: (await service.status("workspace")).epoch });
    expect(await service.quickFixes("workspace", { ...query, file: "../outside.bp" })).toEqual({
      kind: "stale",
      epoch: (await service.status("workspace")).epoch,
    });
    expect(
      await service.quickFixes("workspace", {
        ...query,
        diagnostic: { ...diagnostic, code: "BP1030" },
      }),
    ).toEqual({ kind: "stale", epoch: (await service.status("workspace")).epoch });
    const cancelled = service.quickFixes("workspace", query);
    service.cancel();
    expect(await cancelled).toEqual({
      kind: "stale",
      epoch: (await service.status("workspace")).epoch,
    });
    expect(await service.quickFixes("workspace", query)).toEqual({
      kind: "stale",
      epoch: (await service.status("workspace")).epoch,
    });
    const next = await service.sync("workspace", {
      ...request,
      revision: 2,
      baseRevision: 1,
      analysisBase: reply.patch.version,
      overlays: { set: { "main.bp": "LCD.Clear()\n" }, removed: [] },
    });
    expect(next.kind).toBe("result");
    expect(await service.quickFixes("workspace", query)).toEqual({
      kind: "stale",
      epoch: (await service.status("workspace")).epoch,
    });
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("cancels one quick-fix query through shared memory without invalidating other queries or analysis", async () => {
    const reply = await service.sync("workspace", {
      epoch: (await service.status("workspace")).epoch,
      session: "isolated-fixes",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: { "main.bp": "LCD.Clear(\n" }, removed: [] },
    });
    if (reply.kind !== "result") throw new Error("resync");
    const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics.find(
      (d) => d.code === "BP1043",
    )!;
    const query = {
      epoch: (await service.status("workspace")).epoch,
      requestId: "first",
      session: "isolated-fixes",
      revision: 1,
      analysisVersion: reply.patch.version,
      file: "main.bp",
      diagnostic,
    };
    const post = vi.spyOn(workers[0]!, "postMessage");
    const first = service.quickFixes("workspace", query);
    const second = service.quickFixes("workspace", { ...query, requestId: "second" });
    const firstMessage = post.mock.calls[0]![0] as { cancellation: SharedArrayBuffer };
    const secondMessage = post.mock.calls[1]![0] as { cancellation: SharedArrayBuffer };
    service.cancelQuickFix("another-workspace", "first");
    expect(Atomics.load(new Int32Array(firstMessage.cancellation), 0)).toBe(0);
    service.cancelQuickFix("workspace", "first");
    expect(Atomics.load(new Int32Array(firstMessage.cancellation), 0)).toBe(1);
    expect(Atomics.load(new Int32Array(secondMessage.cancellation), 0)).toBe(0);
    expect(await first).toEqual({
      kind: "stale",
      epoch: (await service.status("workspace")).epoch,
    });
    expect(await second).toMatchObject({
      kind: "result",
      fixes: [{ title: { en: "Insert closing parenthesis )" } }],
    });
    // Accepted analysis remains queryable after individual cancellation.
    expect(await service.quickFixes("workspace", { ...query, requestId: "third" })).toMatchObject({
      kind: "result",
      fixes: [{ title: { en: "Insert closing parenthesis )" } }],
    });
    service.cancelQuickFix("workspace", "first"); // Late cancellation is harmless.
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("discards quick-fix requests on a worker exit and reanalysis creates a fresh version", async () => {
    const update: LanguageSyncRequest = {
      epoch: (await service.status("workspace")).epoch,
      session: "fix",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: { "main.bp": "While True\n" }, removed: [] },
    };
    const reply = await service.sync("workspace", update);
    if (reply.kind !== "result") throw new Error("resync");
    const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics.find(
      (d) => d.code === "BP1031",
    )!;
    const query = {
      epoch: (await service.status("workspace")).epoch,
      requestId: "fix-query",
      session: "fix",
      revision: 1,
      analysisVersion: reply.patch.version,
      file: "main.bp",
      diagnostic,
    };
    await workers[0]!.terminate();
    expect(await service.quickFixes("workspace", query)).toEqual({
      kind: "stale",
      epoch: (await service.status("workspace")).epoch,
    });
    const fresh = await service.sync("workspace", {
      ...update,
      epoch: (await service.status("workspace")).epoch,
      revision: 2,
      baseRevision: null,
    });
    if (fresh.kind !== "result") throw new Error("resync");
    expect(
      await service.quickFixes("workspace", {
        ...query,
        epoch: fresh.epoch,
        revision: 2,
        analysisVersion: fresh.patch.version,
      }),
    ).toMatchObject({
      kind: "result",
      fixes: [{ title: { en: "Close unfinished blocks at end of file" } }],
    });
  });

  it("runs completion independently, synchronizes edits and recovers from worker restarts", async () => {
    const initial: CompletionSyncRequest = {
      epoch: (await service.status("workspace")).epoch,
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
      const first = await service.completionSync("workspace", initial);
      if (first.kind !== "result") throw new Error("resync");
      expect(
        Object.values(first.index.symbols).some(
          (s) =>
            s.name === "localValue" && first.index.scopes.some((scope) => scope.id === s.group),
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
      const second = await service.completionSync("workspace", edited);
      if (second.kind !== "result") throw new Error("resync");
      expect(second.versions["main.bp"]).toBe(2);
      expect(Object.values(second.index.symbols).some((s) => s.name === "fresh")).toBe(true);
      service.cancel();
      await diagnostics.catch((error) => expect(String(error)).toContain("cancelled"));
      await workers[0]!.terminate();
      expect(
        await service.completionSync("workspace", {
          ...edited,
          revision: 3,
          baseRevision: 2,
          updates: [],
        }),
      ).toEqual({ kind: "resync", epoch: (await service.status("workspace")).epoch });
      const restarted = await service.completionSync("workspace", {
        ...initial,
        epoch: (await service.status("workspace")).epoch,
        revision: 4,
      });
      expect(restarted.kind).toBe("result");
      expect(workers.filter((worker) => worker.threadId !== -1)).toHaveLength(1);
      const switched = await service.completionSync("other", {
        ...initial,
        epoch: (await service.status("other")).epoch,
        session: "other",
        updates: [
          { kind: "reset", file: "main.bp", document: { version: 1, text: "different = 1" } },
        ],
      });
      if (switched.kind !== "result") throw new Error("resync");
      expect(Object.values(switched.index.symbols).map((s) => s.name)).toEqual(["different"]);
    } finally {
      service.close("other");
    }
  });
  it("rejects an old result after a same-provider restart", async () => {
    const first = await service.status("workspace");
    const update = {
      epoch: first.epoch,
      session: "restart",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: { "main.bp": "LCD.Clear(\n" }, removed: [] },
    };
    const reply = await service.sync("workspace", update);
    if (reply.kind !== "result") throw new Error("Expected result");
    const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics[0]!;
    await workers[0]!.terminate();
    await vi.waitFor(async () =>
      expect((await service.status("workspace")).epoch).toBeGreaterThan(first.epoch),
    );
    expect(
      await service.quickFixes("workspace", {
        epoch: first.epoch,
        requestId: "old",
        session: update.session,
        revision: 1,
        analysisVersion: reply.patch.version,
        file: "main.bp",
        diagnostic,
      }),
    ).toMatchObject({ kind: "stale", epoch: (await service.status("workspace")).epoch });
    expect(await service.sync("workspace", update)).toMatchObject({ kind: "resync" });
    const next = await service.status("workspace");
    expect(
      await service.sync("workspace", { ...update, epoch: next.epoch, revision: 2 }),
    ).toMatchObject({
      kind: "result",
      epoch: next.epoch,
      patch: { base: null },
    });
  });
  it("does not start a worker for a missing language service", async () => {
    await writeFile(
      path.join(root, "kobrixa.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "missing",
        language: "case",
        target: "missing-vm",
        entry: "main.csx",
        assets: [],
        outputDir: "out",
      }),
    );
    const status = await service.status("workspace", true);
    const reply = await service.sync("workspace", {
      epoch: status.epoch,
      session: "s",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: {}, removed: [] },
    });
    expect(reply).toEqual({
      kind: "unavailable",
      epoch: status.epoch,
      reason: "missing",
      language: "case",
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("routes semantic queries by accepted identity and cancels them independently", async () => {
    const epoch = (await service.status("workspace")).epoch;
    const update: LanguageSyncRequest = {
      epoch,
      session: "features",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: { "main.bp": "value = 1\nLCD.Clear(\n" }, removed: [] },
    };
    const analysis = await service.sync("workspace", update);
    if (analysis.kind !== "result") throw new Error("Expected analysis");
    const request: LanguageFeatureRequest = {
      epoch,
      session: update.session,
      revision: 1,
      analysisVersion: analysis.patch.version,
      requestId: "first",
      query: { kind: "hover", file: "main.bp", line: 1, column: 1 },
    };
    const post = vi.spyOn(workers[0]!, "postMessage");
    const first = service.feature("workspace", request);
    const duplicate = service.feature("workspace", request);
    const second = service.feature("workspace", { ...request, requestId: "second" });
    expect(await duplicate).toEqual({ kind: "stale", epoch });
    service.cancelFeature("other", request.requestId);
    expect(Atomics.load(new Int32Array(post.mock.calls[0]![0].cancellation), 0)).toBe(0);
    service.cancelFeature("workspace", request.requestId);
    expect(Atomics.load(new Int32Array(post.mock.calls[0]![0].cancellation), 0)).toBe(1);
    expect(Atomics.load(new Int32Array(post.mock.calls[1]![0].cancellation), 0)).toBe(0);
    expect(await first).toEqual({ kind: "stale", epoch });
    expect(await second).toMatchObject({
      kind: "result",
      epoch,
      result: {
        kind: "hover",
        value: { contents: [expect.stringContaining("value")] },
      },
    });
    expect(await service.feature("workspace", { ...request, epoch: epoch + 1 })).toEqual({
      kind: "stale",
      epoch,
    });
    expect(
      await service.feature("workspace", {
        ...request,
        query: { kind: "documentSymbols", file: "kobrixa.json" },
      }),
    ).toEqual({ kind: "stale", epoch });
    await service.sync("workspace", {
      ...update,
      revision: 2,
      baseRevision: 1,
      analysisBase: analysis.patch.version,
    });
    expect(await service.feature("workspace", request)).toEqual({ kind: "stale", epoch });
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("applies superseded completion edits in order and discovers disk files only on refresh", async () => {
    const epoch = (await service.status("workspace")).epoch;
    const initial: CompletionSyncRequest = {
      epoch,
      session: "ordered-completion",
      revision: 1,
      baseRevision: null,
      refresh: true,
      updates: [{ kind: "reset", file: "main.bp", document: { version: 1, text: "kept = 1\n" } }],
    };
    expect((await service.completionSync("workspace", initial)).kind).toBe("result");
    await writeFile(path.join(root, "extra.bpm"), "Sub FromDisk()\nEndSub\n");
    const worker = workers[0]!;
    const post = worker.postMessage.bind(worker);
    let latest!: ReturnType<LanguageService["completionSync"]>;
    let dispatched!: () => void;
    const ready = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    vi.spyOn(worker, "postMessage").mockImplementationOnce((message) => {
      post(message);
      latest = service.completionSync("workspace", {
        ...initial,
        refresh: false,
        revision: 3,
        baseRevision: 2,
        updates: [
          {
            kind: "edit",
            file: "main.bp",
            before: 2,
            version: 3,
            changes: [{ offset: "kept = 1\nmiddle = 2\n".length, length: 0, text: "last = 3\n" }],
          },
        ],
      });
      dispatched();
    });
    const obsolete = service.completionSync("workspace", {
      ...initial,
      refresh: false,
      revision: 2,
      baseRevision: 1,
      updates: [
        {
          kind: "edit",
          file: "main.bp",
          before: 1,
          version: 2,
          changes: [{ offset: "kept = 1\n".length, length: 0, text: "middle = 2\n" }],
        },
        { kind: "reset", file: "ignored.json", document: { version: 1, text: "ignored = 1\n" } },
      ],
    });
    const rejected = expect(obsolete).rejects.toThrow("superseded");
    await ready;
    await rejected;
    const result = await latest;
    if (result.kind !== "result") throw new Error("Expected completion");
    expect(result.versions["main.bp"]).toBe(3);
    expect(
      Object.values(result.index.symbols)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["kept", "last", "middle"]);
    expect(workers).toHaveLength(1);
    expect((await service.status("workspace")).epoch).toBe(epoch);
    const refreshed = await service.completionSync("workspace", {
      ...initial,
      revision: 4,
      baseRevision: 3,
      refresh: true,
      updates: [],
    });
    if (refreshed.kind !== "result") throw new Error("Expected completion");
    expect(Object.values(refreshed.index.symbols).some((s) => s.name === "FromDisk")).toBe(true);
  });

  it("keeps raw manifest routing stable through loading and invalidates malformed/recovered descriptions", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "raw",
      language: "bp",
      target: "missing-vm",
      entry: "./main.bp",
      outputDir: "out",
      assets: [],
    };
    await writeFile(path.join(root, "kobrixa.json"), JSON.stringify(manifest));
    const first = await service.status("workspace");
    const listener = vi.fn();
    const off = service.onStatus(listener);
    const update: LanguageSyncRequest = {
      epoch: first.epoch,
      session: "raw",
      revision: 1,
      baseRevision: null,
      analysisBase: null,
      overlays: { set: { "main.bp": "value = 1\n" }, removed: [] },
    };
    expect((await service.sync("workspace", update)).kind).toBe("result");
    expect((await service.status("workspace", true)).epoch).toBe(first.epoch);
    expect(listener).not.toHaveBeenCalled();
    await writeFile(path.join(root, "kobrixa.json"), "{");
    await service.refresh("workspace");
    const invalid = await service.status("workspace");
    expect(invalid.epoch).toBeGreaterThan(first.epoch);
    const broken = await service.sync("workspace", { ...update, epoch: invalid.epoch });
    if (broken.kind !== "result") throw new Error("Expected core diagnostics");
    expect(applyAnalysis(undefined, broken.patch).analysis).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "MAN1001", source: "kobrixa.core" })],
      index: { symbols: {} },
      tokensByFile: {},
    });
    await writeFile(path.join(root, "kobrixa.json"), JSON.stringify(manifest));
    await service.refresh("workspace");
    const recovered = await service.status("workspace");
    expect(recovered.epoch).toBeGreaterThan(invalid.epoch);
    const next = await service.sync("workspace", { ...update, epoch: recovered.epoch });
    expect(next).toMatchObject({ kind: "result", epoch: recovered.epoch, patch: { base: null } });
    off();
    const calls = listener.mock.calls.length;
    await service.refresh("workspace");
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it.each(["analysis", "completion"] as const)(
    "does not revive a closed workspace while %s awaits its cached status",
    async (lane) => {
      const status = await service.status("workspace");
      const identity = { epoch: status.epoch, session: "close", revision: 1, baseRevision: null };
      const pending =
        lane === "analysis"
          ? service.sync("workspace", {
              ...identity,
              analysisBase: null,
              overlays: { set: {}, removed: [] },
            })
          : service.completionSync("workspace", { ...identity, refresh: false, updates: [] });
      const rejected = expect(pending).rejects.toThrow("Diagnostics cancelled.");
      service.close("workspace");
      await rejected;
      expect(workers).toHaveLength(0);
      const listener = vi.fn();
      service.onStatus(listener);
      await service.refresh();
      expect(listener).not.toHaveBeenCalled();
    },
  );
});
