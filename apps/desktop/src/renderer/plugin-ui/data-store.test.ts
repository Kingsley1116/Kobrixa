import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  canonicalDatasetV2Bytes,
  type DatasetDeclarationV2,
  type DatasetHeaderV2,
  type DatasetChunkV2,
  type UiDataRequestMapV2,
} from "@kobrixa/plugin-protocol";
import { UiDatasetStore, type UiDatasetReadPort } from "./data-store.js";
const binding: UiDataRequestMapV2["ui/dataRead"]["params"]["binding"] = {
  kind: "panel",
  contributionId: "test.lab.panel",
  panelInstance: "00000000-0000-4000-8000-000000000001",
  hostEpoch: "00000000-0000-4000-8000-000000000002",
  processEpoch: "00000000-0000-4000-8000-000000000003",
  generation: 1,
  uiResourceGeneration: 1,
};
function fixture(entries: string[] = ["one", "two"]) {
  const bytes = canonicalDatasetV2Bytes({ kind: "code" }, entries);
  const metadata = {
    dataset: "code",
    revision: 1,
    presentation: 1,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const snapshot = vi.fn<UiDatasetReadPort["snapshot"]>(async () => ({
    ok: true,
    value: { datasets: [{ ...metadata }] },
  }));
  const read = vi.fn<UiDatasetReadPort["read"]>(async ({ offset }) => {
    const { revision, presentation, byteLength, sha256 } = metadata;
    return {
      ok: true,
      value: {
        revision,
        presentation,
        byteLength,
        sha256,
        header: { kind: "code" },
        chunk: { kind: "code", entries: entries.slice(offset, offset + 1) },
        nextOffset: Math.min(offset + 1, entries.length),
        done: offset + 1 >= entries.length,
      },
    };
  });
  const store = new UiDatasetStore(binding, { code: { kind: "code" } }, { snapshot, read });
  return { store, read, snapshot, metadata };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
it("assembles verified pages once, gates presentation, and exposes frozen shared data", async () => {
  const f = fixture();
  await f.store.invalidate();
  expect(f.store.dataset("code")).toBeUndefined();
  f.store.setPresentation(1);
  const data = f.store.dataset("code");
  expect(data).toEqual({ header: { kind: "code" }, entries: ["one", "two"] });
  expect(f.store.dataset("code")).toBe(data);
  expect(Object.isFrozen(data!.entries)).toBe(true);
  await f.store.invalidate();
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.snapshot).toHaveBeenCalledTimes(2);
  f.store.setPresentation(2);
  expect(f.store.dataset("code")).toBeUndefined();
  expect(() => f.store.setPresentation(1)).toThrow();
  f.store.retire();
});
it.each(["checksum", "length", "revision", "header", "progress", "undeclared", "aggregate"])(
  "refuses %s corruption before displaying a dataset",
  async (kind) => {
    const f = fixture();
    f.store.setPresentation(1);
    if (kind === "checksum") f.metadata.sha256 = "0".repeat(64);
    if (kind === "length") f.metadata.byteLength++;
    if (kind === "undeclared") f.metadata.dataset = "foreign";
    if (kind === "aggregate") f.metadata.byteLength = 524289;
    const original = f.read.getMockImplementation()!;
    if (["revision", "header", "progress"].includes(kind)) {
      f.read.mockImplementation(async (params, signal) => {
        const response = await original(params, signal);
        if (!response.ok) return response;
        if (kind === "revision") response.value.revision++;
        if (kind === "header") {
          response.value.header = { kind: "table" };
        }
        if (kind === "progress") response.value.nextOffset = params.offset;
        return response;
      });
    }
    await f.store.invalidate();
    expect(f.store.getSnapshot().unavailable).toBe(true);
    expect(f.store.dataset("code")).toBeUndefined();
    f.store.retire();
  },
);
it("coalesces invalidations, aborts superseded reads and ignores late data after retirement", async () => {
  const f = fixture();
  const pending = deferred<Awaited<ReturnType<UiDatasetReadPort["read"]>>>();
  const started = deferred<void>();
  let signal!: AbortSignal;
  f.read.mockImplementationOnce((_input, s) => {
    signal = s;
    started.resolve();
    return pending.promise;
  });
  const first = f.store.invalidate();
  await started.promise;
  const second = f.store.invalidate();
  const third = f.store.invalidate();
  expect(first).toBe(second);
  expect(second).toBe(third);
  expect(signal.aborted).toBe(true);
  await third;
  f.store.setPresentation(1);
  expect(f.store.dataset("code")?.entries).toEqual(["one", "two"]);
  f.store.retire();
  pending.resolve({
    ok: false,
    error: {
      code: "PLUGIN_E_STALE_RESOURCE",
      message: "gone",
      detail: { kind: "ui-data", reason: "stale" },
    },
  });
  await Promise.resolve();
  expect(f.store.dataset("code")).toBeUndefined();
  expect(f.store.getSnapshot()).toMatchObject({ active: false, loading: false });
  await f.store.invalidate();
  expect(f.snapshot).toHaveBeenCalledTimes(2);
});
it("times out even if the bridge ignores cancellation and cancels its deadline on retire", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.snapshot.mockImplementation(() => new Promise(() => {}));
    const work = f.store.invalidate();
    await vi.advanceTimersByTimeAsync(5000);
    await work;
    expect(f.store.getSnapshot()).toMatchObject({ loading: false, unavailable: true });
    expect(vi.getTimerCount()).toBe(0);
    const next = f.store.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    f.store.retire();
    await next;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it("rejects metadata changing without revision, and can recover after a failed page", async () => {
  const f = fixture();
  f.store.setPresentation(1);
  await f.store.invalidate();
  f.metadata.sha256 = "0".repeat(64);
  await f.store.invalidate();
  expect(f.store.getSnapshot().unavailable).toBe(true);
  f.metadata.revision++;
  f.metadata.sha256 = createHash("sha256")
    .update(canonicalDatasetV2Bytes({ kind: "code" }, ["one", "two"]))
    .digest("hex");
  await f.store.invalidate();
  expect(f.store.getSnapshot().unavailable).toBe(false);
  expect(f.store.dataset("code")?.entries).toEqual(["one", "two"]);
  f.store.retire();
});
it("only enables a chart group when every dataset has matching presentation and full domain", async () => {
  const header = (end: number): DatasetHeaderV2 => ({
    kind: "chart",
    timeDomain: [0, end],
    view: "recent60s",
    series: [
      {
        id: "s",
        unit: "",
        range: [0, 1],
        extrema: null,
        fullPointCount: 0,
        omittedPoints: 0,
        omittedRuns: 0,
      },
    ],
  });
  let end = 100000;
  const declared: DatasetDeclarationV2 = {
    kind: "chart",
    series: [{ id: "s", label: { en: "Sensor" } }],
  };
  const meta = (id: string) => {
    const bytes = canonicalDatasetV2Bytes(header(id === "a" ? 100000 : end), []);
    return {
      dataset: id,
      revision: end,
      presentation: 1,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const store = new UiDatasetStore(
    binding,
    { a: declared, b: declared },
    {
      snapshot: async () => ({ ok: true, value: { datasets: [meta("a"), meta("b")] } }),
      read: async ({ dataset }) => {
        const { revision, presentation, byteLength, sha256 } = meta(dataset);
        return {
          ok: true,
          value: {
            revision,
            presentation,
            byteLength,
            sha256,
            header: header(dataset === "a" ? 100000 : end),
            chunk: { kind: "chart", entries: [] } satisfies DatasetChunkV2,
            nextOffset: 0,
            done: true,
          },
        };
      },
    },
  );
  store.setPresentation(1);
  await store.invalidate();
  expect(store.chartGroup(["a", "b"])).toHaveLength(2);
  expect(store.chartGroup(["a", "a"])).toBeUndefined();
  end = 100001;
  await store.invalidate();
  expect(store.chartGroup(["a", "b"])).toBeUndefined();
  store.retire();
});
it("revocation from an observer prevents any subsequent page dispatch", async () => {
  const f = fixture();
  f.store.subscribe(() => {
    if (f.snapshot.mock.calls.length > 0) f.store.retire();
  });
  await f.store.invalidate();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.store.getSnapshot().active).toBe(false);
});
it("does not lose a refresh requested while the prior drain is settling", async () => {
  const f = fixture();
  let refresh = false;
  f.store.subscribe(() => {
    if (!f.store.getSnapshot().loading && !refresh) {
      refresh = true;
      void f.store.invalidate();
    }
  });
  await f.store.invalidate();
  expect(f.snapshot).toHaveBeenCalledTimes(2);
  expect(f.read).toHaveBeenCalledTimes(2);
  f.store.retire();
});
