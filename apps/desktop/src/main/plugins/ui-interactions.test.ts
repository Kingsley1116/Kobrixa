import { expect, it, vi } from "vitest";
import type { Principal } from "@kobrixa/plugin-runtime";
import { releaseUiRecording } from "./ui-bridge.js";
const reservation = "00000000-0000-4000-8000-000000000004";
const owner = {
  sourceKey: "builtin:test.lab",
  pluginId: "test.lab",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const principal: Extract<Principal, { kind: "plugin" }> = {
  kind: "plugin",
  owner,
  authorityContext: null,
};
function fixture() {
  let current = true,
    p = principal;
  const request = vi.fn<Parameters<typeof releaseUiRecording>[0]["request"]>(async () => ({
    ok: true,
    value: {},
  }));
  const call = () =>
    releaseUiRecording({ owner, reservation, principal: () => p, current: () => current, request });
  return {
    request,
    call,
    retire: () => {
      current = false;
    },
    foreign: () => {
      p = { ...principal, owner: { ...owner, processEpoch: reservation } };
    },
  };
}
it("recording Stop queries and releases only the original plugin owner, including repeat/ended replies", async () => {
  const h = fixture();
  expect(await h.call()).toEqual({ ok: true, value: { output: {}, fieldErrors: [] } });
  expect(h.request.mock.calls.map((c) => c[1])).toEqual([
    "devices/recording/query",
    "devices/recording/release",
  ]);
  for (const args of h.request.mock.calls) {
    expect(args[0]).toEqual(principal);
    expect(args[2]).toEqual({ reservationId: reservation });
    expect(args[3]).toBeInstanceOf(AbortSignal);
  }
  expect((await h.call()).ok).toBe(true);
  expect(h.request.mock.calls.some((c) => c[1].includes("motion"))).toBe(false);
});
it.each(["query", "retire", "foreign"])("Stop refuses %s failure before release", async (mode) => {
  const h = fixture();
  h.request.mockImplementationOnce(async () => {
    if (mode === "query")
      return {
        ok: false,
        error: { code: "PLUGIN_E_STALE_RESOURCE", message: "foreign reservation" },
      };
    if (mode === "retire") h.retire();
    else h.foreign();
    return { ok: true, value: {} };
  });
  expect((await h.call()).ok).toBe(false);
  expect(h.request).toHaveBeenCalledTimes(1);
});
it("null or invalid reservation never reaches the broker and late retirement never reports accepted", async () => {
  const h = fixture();
  for (const id of [null, "", 123, "not-a-uuid"]) {
    expect(
      (
        await releaseUiRecording({
          owner,
          reservation: id,
          principal: () => principal,
          current: () => true,
          request: h.request,
        })
      ).ok,
    ).toBe(false);
  }
  expect(h.request).not.toHaveBeenCalled();
  h.request.mockImplementation(async (_p, method) => {
    if (method === "devices/recording/release") h.retire();
    return { ok: true, value: {} };
  });
  expect((await h.call()).ok).toBe(false);
});
