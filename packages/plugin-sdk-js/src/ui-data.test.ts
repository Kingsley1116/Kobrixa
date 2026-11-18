import { describe, expect, it, vi } from "vitest";
import { UiDataClient, type UiDataRequestPort } from "./ui-data.js";
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
const base = { binding, dataset: "code" };
const metadata = { revision: 1, presentation: 1, byteLength: 20, sha256: "a".repeat(64) };
const begin = {
  ...base,
  baseRevision: 0,
  presentation: 1,
  header: { kind: "code" as const },
  entryCount: 0,
  byteLength: 20,
  sha256: metadata.sha256,
};
function fixture(reply: unknown) {
  const request = vi.fn(async () => reply);
  const client = new UiDataClient(request as UiDataRequestPort);
  return { client, request };
}
describe("local UI v2 data facade", () => {
  it("requires explicit readiness and rejects status bindings before transport", async () => {
    const { client, request } = fixture({ ok: true, value: { datasets: [] } });
    await expect(client.snapshot(binding)).rejects.toThrow("not ready");
    client.markReady();
    await expect(client.snapshot({ ...binding, kind: "status" })).rejects.toThrow("parameters");
    expect(request).not.toHaveBeenCalled();
    await expect(client.snapshot(binding)).resolves.toEqual({ ok: true, value: { datasets: [] } });
    client.retire();
    await expect(client.snapshot(binding)).rejects.toThrow("not ready");
  });
  it("uses one five-second request per method, forwarding the caller signal", async () => {
    const { client, request } = fixture({
      ok: true,
      value: { transfer: id, nextOffset: 0, remainingMs: 10000 },
    });
    client.markReady();
    const signal = new AbortController().signal;
    await client.begin(begin, signal);
    request.mockResolvedValue({ ok: true, value: { nextOffset: 1, remainingMs: 5000 } });
    await client.chunk(
      { ...base, transfer: id, offset: 0, chunk: { kind: "code", entries: ["x"] } },
      signal,
    );
    request.mockResolvedValue({ ok: true, value: metadata });
    await client.commit({ ...base, transfer: id }, signal);
    request.mockResolvedValue({ ok: true, value: { aborted: false } });
    await client.abort({ ...base, transfer: id }, signal);
    request.mockResolvedValue({
      ok: true,
      value: {
        ...metadata,
        header: { kind: "code" },
        chunk: { kind: "code", entries: [] },
        nextOffset: 0,
        done: true,
      },
    });
    await client.read({ ...base, revision: 1, offset: 0, limit: 10 }, signal);
    request.mockResolvedValue({ ok: true, value: { datasets: [] } });
    await client.snapshot(binding, signal);
    expect(request.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "ui/dataBegin",
      "ui/dataChunk",
      "ui/dataCommit",
      "ui/dataAbort",
      "ui/dataRead",
      "ui/dataSnapshot",
    ]);
    for (const c of request.mock.calls as unknown[][])
      expect(c[2]).toEqual({ timeoutMs: 5000, signal });
  });
  it("does not retry or auto-abort a failed or cancelled call", async () => {
    const { client, request } = fixture(null);
    client.markReady();
    const control = new AbortController();
    control.abort(new Error("cancelled"));
    await expect(client.begin(begin, control.signal)).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
    request.mockRejectedValue(new Error("transport timeout"));
    await expect(client.commit({ ...base, transfer: id })).rejects.toThrow("timeout");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects a late old-session result even after the next session becomes ready", async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = new UiDataClient(request as UiDataRequestPort);
    client.markReady();
    const pending = client.snapshot(binding);
    client.retire();
    client.markReady();
    finish({ ok: true, value: { datasets: [] } });
    await expect(pending).rejects.toThrow("retired");
  });
  it("checks semantic progress and rejects duplicate metadata and wrong errors", async () => {
    const { client, request } = fixture({
      ok: true,
      value: {
        ...metadata,
        header: { kind: "code" },
        chunk: { kind: "code", entries: [] },
        nextOffset: 0,
        done: false,
      },
    });
    client.markReady();
    await expect(client.read({ ...base, revision: 1, offset: 0, limit: 1 })).rejects.toThrow();
    request.mockResolvedValue({
      ok: true,
      value: {
        datasets: [
          { ...metadata, dataset: "code" },
          { ...metadata, dataset: "code" },
        ],
      },
    });
    await expect(client.snapshot(binding)).rejects.toThrow();
    request.mockResolvedValue({
      ok: false,
      error: {
        code: "PLUGIN_E_RESOURCE_LIMIT",
        message: "Rejected",
        detail: { kind: "ui-data", reason: "checksum" },
      },
    });
    await expect(client.commit({ ...base, transfer: id })).rejects.toThrow("result");
    const denied = {
      ok: false,
      error: {
        code: "PLUGIN_E_RESOURCE_LIMIT",
        message: "Rejected",
        detail: { kind: "ui-data", reason: "quota" },
      },
    };
    request.mockResolvedValue(denied);
    await expect(client.commit({ ...base, transfer: id })).resolves.toEqual(denied);
  });
});

it("holds the parsed request snapshot and honors cancellation during an in-flight read", async () => {
  let finish!: (value: unknown) => void;
  const port = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = new UiDataClient(port as UiDataRequestPort);
  client.markReady();
  const params = { ...base, revision: 1, offset: 0, limit: 1 };
  const pending = client.read(params);
  params.offset = 99;
  finish({
    ok: true,
    value: {
      ...metadata,
      header: { kind: "code" },
      chunk: { kind: "code", entries: ["x"] },
      nextOffset: 1,
      done: true,
    },
  });
  await expect(pending).resolves.toMatchObject({ ok: true });
  const control = new AbortController();
  const cancelled = client.snapshot(binding, control.signal);
  control.abort(new Error("cancel in flight"));
  finish({ ok: true, value: { datasets: [] } });
  await expect(cancelled).rejects.toThrow("cancel in flight");
  expect(port).toHaveBeenCalledTimes(2);
});
