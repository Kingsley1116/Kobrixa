import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  readSource,
  resolvePlugins,
  resolveFrontendProvider,
  resolveCompilerProviders,
} from "@kobrixa/plugin-runtime";
import { applyAnalysis } from "../../shared/language-sync.js";
import { LanguageWorkerSession } from "./language-worker-session.js";
import {
  SECOND_MANIFEST,
  secondBinding,
  secondLanguageService,
} from "./testing/second-language.js";
import type {
  DiagnosticsRequest,
  QuickFixWorkerRequest,
  FeatureWorkerRequest,
} from "./language-protocol.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-second-language-"));
  await writeFile(
    path.join(root, "kobrixa.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "case",
      language: "case",
      target: "absent",
      entry: "main.csx",
      assets: [],
      outputDir: "out",
    }),
  );
  await writeFile(path.join(root, "main.csx"), "Foo foo !\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));
it("isolates case-sensitive symbols, legends and overlapping diagnostic codes", async () => {
  const read = await readSource(
    { kind: "builtin", manifest: SECOND_MANIFEST },
    { safeMode: false },
  );
  const plugins = resolvePlugins([read], { safeMode: false, disabled: new Set() });
  expect(resolveFrontendProvider(plugins, "case").ok).toBe(true);
  expect(resolveCompilerProviders(plugins, "case", "absent").ok).toBe(false);
  const worker = new LanguageWorkerSession({ "test.case:case": secondLanguageService });
  try {
    const request: DiagnosticsRequest = {
      id: 1,
      workspaceId: "w",
      binding: secondBinding(1),
      cancellation: new SharedArrayBuffer(4),
      input: { inputPath: root },
      sync: {
        epoch: 1,
        session: "case",
        revision: 1,
        baseRevision: null,
        analysisBase: null,
        overlays: { set: {}, removed: [] },
      },
    };
    const reply = await worker.sync(request);
    if (reply.kind !== "result") throw new Error("Expected analysis");
    const result = applyAnalysis(undefined, reply.patch).analysis;
    expect(Object.values(result.index.symbols).map((symbol) => symbol.name)).toEqual([
      "Foo",
      "foo",
    ]);
    expect(result.tokensByFile["main.csx"]!.map((token) => token.type)).toEqual([
      "caseIdentifier",
      "caseIdentifier",
    ]);
    expect(result.tokensByFile["main.csx"]!.map((token) => token.modifiers)).toEqual([
      ["mutable"],
      ["mutable"],
    ]);
    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic).toMatchObject({ code: "BP1043", source: "test.case" });
    const query: QuickFixWorkerRequest = {
      kind: "quick-fixes",
      id: 2,
      workspaceId: "w",
      cancellation: new SharedArrayBuffer(4),
      request: {
        epoch: 1,
        requestId: "fix",
        session: "case",
        revision: 1,
        analysisVersion: reply.patch.version,
        file: "main.csx",
        diagnostic,
      },
    };
    expect(worker.quickFixes(query)).toMatchObject({
      kind: "result",
      fixes: [{ id: "case.remove-bang", title: { en: "Remove !" } }],
    });
    expect(
      worker.quickFixes({
        ...query,
        request: { ...query.request, diagnostic: { ...diagnostic, source: "kobrixa.basic-plus" } },
      }),
    ).toMatchObject({ kind: "stale" });
    expect(worker.quickFixes({ ...query, request: { ...query.request, epoch: 2 } })).toMatchObject({
      kind: "stale",
    });
    const next = await worker.sync({
      ...request,
      id: 3,
      binding: secondBinding(2),
      sync: { ...request.sync, epoch: 2, revision: 2 },
    });
    expect(next).toMatchObject({ kind: "result", epoch: 2, patch: { base: null } });
    expect(worker.quickFixes(query)).toMatchObject({ kind: "stale" });
  } finally {
    worker.dispose();
  }
});

it("gates feature queries by the binding capability without calling the provider", async () => {
  const provider = secondLanguageService.createAnalysis();
  const query = vi.spyOn(provider, "query");
  const worker = new LanguageWorkerSession({
    "test.case:case": { ...secondLanguageService, createAnalysis: () => provider },
  });
  try {
    const request: DiagnosticsRequest = {
      id: 1,
      workspaceId: "w",
      binding: { ...secondBinding(1), capabilities: ["analysis"] },
      cancellation: new SharedArrayBuffer(4),
      input: { inputPath: root },
      sync: {
        epoch: 1,
        session: "case",
        revision: 1,
        baseRevision: null,
        analysisBase: null,
        overlays: { set: {}, removed: [] },
      },
    };
    const reply = await worker.sync(request);
    if (reply.kind !== "result") throw new Error("Expected analysis");
    const feature: FeatureWorkerRequest = {
      kind: "feature",
      id: 2,
      workspaceId: "w",
      cancellation: new SharedArrayBuffer(4),
      request: {
        epoch: 1,
        requestId: "hover",
        session: "case",
        revision: 1,
        analysisVersion: reply.patch.version,
        query: { kind: "hover", file: "main.csx", line: 1, column: 1 },
      },
    };
    expect(worker.feature(feature)).toEqual({ kind: "stale", epoch: 1 });
    expect(query).not.toHaveBeenCalled();

    // The same query becomes supported when the next binding declares hover.
    const next = await worker.sync({
      ...request,
      id: 3,
      binding: secondBinding(2),
      sync: { ...request.sync, epoch: 2 },
    });
    if (next.kind !== "result") throw new Error("Expected analysis");
    expect(
      worker.feature({
        ...feature,
        id: 4,
        request: { ...feature.request, epoch: 2, analysisVersion: next.patch.version },
      }),
    ).toMatchObject({
      kind: "result",
      epoch: 2,
      result: { kind: "hover", value: { contents: ["case Foo"] } },
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      next.patch.version,
      feature.request.query,
      expect.any(AbortSignal),
    );
  } finally {
    worker.dispose();
  }
});
it("returns no fixes when the selected declaration omits quickFixes", async () => {
  const worker = new LanguageWorkerSession({ "test.case:case": secondLanguageService });
  const binding = { ...secondBinding(1), capabilities: ["analysis" as const] };
  try {
    const reply = await worker.sync({
      id: 1,
      workspaceId: "w",
      binding,
      cancellation: new SharedArrayBuffer(4),
      input: { inputPath: root },
      sync: {
        epoch: 1,
        session: "s",
        revision: 1,
        baseRevision: null,
        analysisBase: null,
        overlays: { set: {}, removed: [] },
      },
    });
    if (reply.kind !== "result") throw new Error("Expected analysis");
    const diagnostic = applyAnalysis(undefined, reply.patch).analysis.diagnostics[0]!;
    expect(
      worker.quickFixes({
        kind: "quick-fixes",
        id: 2,
        workspaceId: "w",
        cancellation: new SharedArrayBuffer(4),
        request: {
          epoch: 1,
          requestId: "r",
          session: "s",
          revision: 1,
          analysisVersion: reply.patch.version,
          file: "main.csx",
          diagnostic,
        },
      }),
    ).toEqual({ kind: "result", epoch: 1, fixes: [] });
  } finally {
    worker.dispose();
  }
});
