import { expect, it, vi } from "vitest";
import { AnalysisTransport } from "./analysis-transport.js";
import type { QuickFixReply, QuickFixRequest } from "../../shared/quick-fixes.js";
import {
  diffAnalysis,
  emptyAnalysis,
  type LanguageSyncRequest,
} from "../../shared/language-sync.js";

function server() {
  const analysis = emptyAnalysis();
  const sync = vi.fn(async (_workspaceId: string, request: LanguageSyncRequest) => ({
    kind: "result" as const,
    session: request.session,
    revision: request.revision,
    patch: diffAnalysis(undefined, analysis, null, request.revision),
  }));
  return { sync, transport: new AnalysisTransport(sync) };
}
it("sends only changed and removed files across canceled analysis", async () => {
  const { sync, transport } = server();
  await transport.analyze("one", { "main.bp": "a = 1", "lib.bpm": "LCD.Clear()" });
  sync.mockRejectedValueOnce(new Error("Error invoking remote method: Diagnostics cancelled."));
  await expect(
    transport.analyze("one", { "main.bp": "a = 2", "lib.bpm": "LCD.Clear()" }),
  ).rejects.toThrow("cancelled");
  await transport.analyze("one", { "main.bp": "a = 2" });
  expect(sync.mock.calls[1]![1].overlays).toEqual({ set: { "main.bp": "a = 2" }, removed: [] });
  expect(sync.mock.calls[2]![1]).toMatchObject({
    baseRevision: 2,
    overlays: { set: {}, removed: ["lib.bpm"] },
  });
});
it("resets after unknown failure or workspace switch and retries a lost server baseline", async () => {
  const { sync, transport } = server();
  const files = { "main.bp": "a = 1" };
  await transport.analyze("one", files);
  sync.mockRejectedValueOnce(new Error("worker exited"));
  await expect(transport.analyze("one", files)).rejects.toThrow("exited");
  await transport.analyze("one", files);
  expect(sync.mock.calls[2]![1]).toMatchObject({
    baseRevision: null,
    analysisBase: null,
    overlays: { set: files, removed: [] },
  });
  const firstSession = sync.mock.calls[2]![1].session;
  await transport.analyze("two", files);
  expect(sync.mock.calls[3]![1].session).not.toBe(firstSession);
  const fallback = server();
  const reset = vi.fn().mockResolvedValueOnce({ kind: "resync" }).mockImplementation(fallback.sync);
  await new AnalysisTransport(reset).analyze("one", files);
  expect(reset).toHaveBeenCalledTimes(2);
  expect(reset.mock.calls[1]![1]).toMatchObject({
    baseRevision: null,
    overlays: { set: files, removed: [] },
  });
});

it("binds quick fixes to the accepted source analysis and discards replies after another revision", async () => {
  const { sync } = server();
  const request = vi.fn(async () => ({ kind: "result" as const, fixes: [] }));
  const transport = new AnalysisTransport(sync, request);
  const analysis = await transport.analyze("one", { "main.bp": "LCD.Clear(" });
  const diagnostic = {
    code: "BP1043",
    severity: "error" as const,
    file: "main.bp",
    range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 12 },
    message: "original",
  };
  expect(await transport.quickFixes(analysis, diagnostic)).toEqual({ kind: "result", fixes: [] });
  expect(request).toHaveBeenCalledWith(
    "one",
    expect.objectContaining({
      revision: 1,
      analysisVersion: 1,
      file: "main.bp",
      diagnostic: { code: "BP1043", range: diagnostic.range },
    }),
  );
  let resolve!: (value: { kind: "result"; fixes: [] }) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = transport.quickFixes(analysis, diagnostic);
  await transport.analyze("two", { "main.bp": "LCD.Clear()" });
  resolve({ kind: "result", fixes: [] });
  expect(await pending).toEqual({ kind: "stale" });
  expect(await transport.quickFixes(analysis, diagnostic)).toEqual({ kind: "stale" });
});

it("cancels only the requested query, settles immediately and removes the abort listener", async () => {
  const { sync } = server();
  const resolvers = new Map<string, (reply: QuickFixReply) => void>();
  const request = vi.fn(
    (_workspaceId: string, query: QuickFixRequest) =>
      new Promise<QuickFixReply>((resolve) => {
        resolvers.set(query.requestId, resolve);
      }),
  );
  const cancel = vi.fn(async () => {});
  const transport = new AnalysisTransport(sync, request, cancel);
  const analysis = await transport.analyze("one", { "main.bp": "LCD.Clear(" });
  const diagnostic = {
    code: "BP1043",
    severity: "error" as const,
    file: "main.bp",
    range: { startLine: 1, startColumn: 11, endLine: 1, endColumn: 12 },
    message: "original",
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = transport.quickFixes(analysis, diagnostic, firstController.signal);
  const second = transport.quickFixes(analysis, diagnostic, secondController.signal);
  const firstId = request.mock.calls[0]![1].requestId;
  const secondId = request.mock.calls[1]![1].requestId;
  expect(firstId).not.toBe(secondId);
  firstController.abort();
  expect(await first).toEqual({ kind: "stale" });
  expect(cancel).toHaveBeenCalledExactlyOnceWith("one", firstId);
  resolvers.get(secondId)!({ kind: "result", fixes: [] });
  expect(await second).toEqual({ kind: "result", fixes: [] });
  secondController.abort();
  expect(cancel).toHaveBeenCalledTimes(1);
  resolvers.get(firstId)!({ kind: "result", fixes: [] });
  const before = request.mock.calls.length;
  expect(await transport.quickFixes(analysis, diagnostic, firstController.signal)).toEqual({
    kind: "stale",
  });
  expect(request).toHaveBeenCalledTimes(before);
});
