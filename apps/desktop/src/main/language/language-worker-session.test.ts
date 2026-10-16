import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { LanguageBinding } from "../../shared/language-services.js";
import { applyAnalysis } from "../../shared/language-sync.js";
import type { DiagnosticsRequest } from "./language-protocol.js";
import { basicPlusLanguageService } from "./basic-plus-service.js";
import { LanguageWorkerSession } from "./language-worker-session.js";
let root: string;
let worker: LanguageWorkerSession;
const binding = (epoch: number): LanguageBinding => ({
  epoch,
  pluginId: "kobrixa.basic-plus",
  sourceKey: "builtin:kobrixa.basic-plus",
  language: "bp",
  extensions: ["bp", "bpi", "bpm"],
  capabilities: [...basicPlusLanguageService.capabilities],
  frontend: {
    language: "bp",
    entryExtensions: ["bp"],
    sourceExtensions: ["bp", "bpi", "bpm"],
    ir: { min: 1, max: 1 },
  },
});
function request(
  epoch: number,
  revision: number,
  baseRevision: number | null,
  text: string,
): DiagnosticsRequest {
  return {
    id: revision,
    workspaceId: "w",
    binding: binding(epoch),
    input: { inputPath: root, selectedEntry: "main.bp" },
    cancellation: new SharedArrayBuffer(4),
    sync: {
      epoch,
      session: "s",
      revision,
      baseRevision,
      analysisBase: null,
      overlays: { set: { "main.bp": text }, removed: [] },
    },
  };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-worker-session-"));
  await writeFile(path.join(root, "main.bp"), "LCD.Clear()\n");
  worker = new LanguageWorkerSession({ "kobrixa.basic-plus:bp": basicPlusLanguageService });
});
afterEach(async () => {
  worker.dispose();
  await rm(root, { recursive: true, force: true });
});
it("applies cancelled deltas before the next request and resets across epochs", async () => {
  const one = request(1, 1, null, "x = 1\n");
  Atomics.store(new Int32Array(one.cancellation), 0, 1);
  await expect(worker.sync(one)).rejects.toThrow("cancelled");
  const two = await worker.sync(request(1, 2, 1, "x = 2\n"));
  expect(two.kind).toBe("result");
  expect(await worker.sync(request(2, 3, 2, "x = 3\n"))).toEqual({ kind: "resync", epoch: 2 });
  const next = await worker.sync(request(2, 4, null, "x = 4\n"));
  if (next.kind !== "result") throw new Error("Expected analysis");
  expect(next.patch.base).toBeNull();
  expect(applyAnalysis(undefined, next.patch).analysis.index.sources["main.bp"]).toBe("x = 4\n");
  expect(await worker.sync(request(1, 5, null, "x = 5\n"))).toEqual({ kind: "resync", epoch: 2 });
});
it("returns resync when the project language changes during loading", async () => {
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "changed",
      language: "case",
      target: "missing-vm",
      entry: "main.csx",
      outputDir: "out",
      assets: [],
    }),
  );
  expect(await worker.sync(request(1, 1, null, "LCD.Clear()\n"))).toEqual({
    kind: "resync",
    epoch: 1,
  });
});
it("returns an empty result when the binding has no quickFixes capability", async () => {
  const fixes = vi.fn(() => []);
  worker.dispose();
  worker = new LanguageWorkerSession({
    "kobrixa.basic-plus:bp": {
      ...basicPlusLanguageService,
      createAnalysis() {
        const provider = basicPlusLanguageService.createAnalysis();
        provider.quickFixes = fixes;
        return provider;
      },
    },
  });
  const update = request(1, 1, null, "LCD.Clear(\n");
  update.binding.capabilities = update.binding.capabilities.filter(
    (capability) => capability !== "quickFixes",
  );
  const reply = await worker.sync(update);
  if (reply.kind !== "result") throw new Error("Expected result");
  const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics.find(
    (item) => item.code === "BP1043",
  )!;
  expect(diagnostic.source).toBe(update.binding.pluginId);
  expect(
    worker.quickFixes({
      kind: "quick-fixes",
      id: 2,
      workspaceId: "w",
      cancellation: new SharedArrayBuffer(4),
      request: {
        epoch: 1,
        session: "s",
        revision: 1,
        analysisVersion: reply.patch.version,
        requestId: "unsupported-fixes",
        file: "main.bp",
        diagnostic,
      },
    }),
  ).toEqual({ kind: "result", epoch: 1, fixes: [] });
  expect(fixes).not.toHaveBeenCalled();
});
it("publishes BUILD1007 for forged sources without retaining a usable fix snapshot", async () => {
  const fixes = vi.fn(() => []);
  const factory = {
    ...basicPlusLanguageService,
    createAnalysis() {
      const provider = basicPlusLanguageService.createAnalysis();
      provider.quickFixes = fixes;
      const analyze = provider.analyze.bind(provider);
      provider.analyze = (...args) => {
        const result = analyze(...args);
        return {
          ...result,
          diagnostics: result.diagnostics.map((d) => ({ ...d, source: "test.forged" })),
        };
      };
      return provider;
    },
  };
  worker.dispose();
  worker = new LanguageWorkerSession({ "kobrixa.basic-plus:bp": factory });
  const reply = await worker.sync(request(1, 1, null, "LCD.Clear(\n"));
  if (reply.kind !== "result") throw new Error("Expected result");
  expect(applyAnalysis(undefined, reply.patch).analysis.diagnostics).toEqual([
    expect.objectContaining({ code: "BUILD1007", source: "kobrixa.core" }),
  ]);
  const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics[0]!;
  for (const source of ["kobrixa.core", "kobrixa.basic-plus", "test.forged"]) {
    expect(
      worker.quickFixes({
        kind: "quick-fixes",
        id: 2,
        workspaceId: "w",
        cancellation: new SharedArrayBuffer(4),
        request: {
          epoch: 1,
          session: "s",
          revision: 1,
          analysisVersion: reply.patch.version,
          requestId: source,
          file: "main.bp",
          diagnostic: { ...diagnostic, source },
        },
      }),
    ).toEqual({ kind: "stale", epoch: 1 });
  }
  expect(fixes).not.toHaveBeenCalled();
});
