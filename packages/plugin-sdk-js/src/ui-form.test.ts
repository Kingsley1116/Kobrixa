import { expect, it, vi } from "vitest";
import { UiClient } from "./ui.js";
const id = "00000000-0000-4000-8000-000000000001";
const binding = {
  contributionId: "test.lab.panel",
  panelInstance: id,
  kind: "panel" as const,
  uiResourceGeneration: 1,
  generation: 1,
  hostEpoch: id,
  processEpoch: id,
};
const result = { ok: true as const, value: { formRevision: 1, form: { a: "-" } } };
function client(request: ReturnType<typeof vi.fn>) {
  return new UiClient(request as never, { adopt: vi.fn(), forget: vi.fn() });
}
it("requires v2 ready, one 5s call, returns stale unchanged without retry", async () => {
  const stale = {
    ok: false,
    error: {
      code: "PLUGIN_E_STALE_RESOURCE",
      message: "Stale form.",
      detail: { kind: "resource", reason: "stale", resource: "ui-binding" },
    },
  };
  const request = vi.fn(async () => stale);
  const ui = client(request);
  await expect(ui.formPatch(binding, 0, { a: "-" })).rejects.toThrow("not ready");
  ui.markReady();
  await expect(ui.formPatch(binding, 0, { a: "-" })).rejects.toThrow("not ready");
  ui.markReady(2);
  expect(await ui.formPatch(binding, 0, { a: "-" })).toEqual(stale);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "ui/formPatch",
    { binding, baseFormRevision: 0, set: { a: "-" } },
    { timeoutMs: 5000 },
  );
});
it("takes private params, rejects malformed correlated result and poisoned input", async () => {
  let finish!: (v: typeof result) => void;
  const request = vi.fn(
    () =>
      new Promise<typeof result>((r) => {
        finish = r;
      }),
  );
  const ui = client(request);
  ui.markReady(2);
  const set = { a: "-" };
  const pending = ui.formPatch(binding, 0, set);
  set.a = "new";
  finish(result);
  expect(await pending).toEqual(result);
  await expect(ui.formPatch(binding, 0, JSON.parse('{"constructor":1}'))).rejects.toThrow(
    "parameters",
  );
  request.mockResolvedValue({ ok: true, value: { formRevision: 2, form: { a: "-" } } });
  await expect(ui.formPatch(binding, 0, { a: "-" })).rejects.toThrow("result");
});
it("fences abort before/after await and retirement even if readiness returns", async () => {
  let finish!: (v: typeof result) => void;
  const request = vi.fn(
    () =>
      new Promise<typeof result>((r) => {
        finish = r;
      }),
  );
  const ui = client(request);
  ui.markReady(2);
  const signal = new AbortController();
  signal.abort();
  await expect(ui.formPatch(binding, 0, { a: "-" }, signal.signal)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  const cancel = new AbortController();
  const first = ui.formPatch(binding, 0, { a: "-" }, cancel.signal);
  cancel.abort();
  finish(result);
  await expect(first).rejects.toThrow();
  const second = ui.formPatch(binding, 0, { a: "-" });
  ui.retire();
  ui.markReady(2);
  finish(result);
  await expect(second).rejects.toThrow("retired");
});
