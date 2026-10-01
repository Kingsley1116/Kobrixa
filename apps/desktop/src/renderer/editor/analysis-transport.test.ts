import { expect, it, vi } from "vitest";
import { AnalysisTransport } from "./analysis-transport.js";
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
