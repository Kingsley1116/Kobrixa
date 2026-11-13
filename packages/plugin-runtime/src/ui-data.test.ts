import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalDatasetV2Bytes,
  type DatasetHeaderV2,
  type DatasetChunkV2,
  type DatasetDeclarationV2,
  type ResourceOwner,
  type UiDataResultV2,
  type UiDataRequestMapV2,
  uiDataRequestSchemasV2,
} from "@kobrixa/plugin-protocol";
import {
  UiDataStore,
  UiDataInvalidParamsError,
  UiDataRpcBoundaryError,
  type UiDataAuthority,
  type UiDataStorePorts,
} from "./ui-data.js";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Binding = UiDataRequestMapV2["ui/dataBegin"]["params"]["binding"];
function ok<T>(r: UiDataResultV2<T>): T {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}
function rejected(r: UiDataResultV2<unknown>, reason: string) {
  expect(r).toMatchObject({ ok: false, error: { detail: { reason } } });
}
function fixture(
  header: DatasetHeaderV2 = { kind: "code" },
  entries: DatasetChunkV2["entries"] = ["one", "two"],
) {
  const bytes = canonicalDatasetV2Bytes(header, entries);
  return {
    header,
    entries,
    entryCount: entries.length,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
function harness() {
  let now = 0;
  let admission: UiDataStorePorts["admitCommit"] = () => "admitted";
  let calls = 0;
  const events: Parameters<UiDataStorePorts["publish"]>[] = [];
  const authorities: UiDataAuthority[] = [];
  const store = new UiDataStore({
    now: () => now,
    resolve: (o, b) =>
      authorities.find(
        (a) =>
          JSON.stringify(a.owner) === JSON.stringify(o) &&
          JSON.stringify(a.binding) === JSON.stringify(b),
      ) ?? null,
    admitCommit: (o, b) => {
      calls++;
      return admission(o, b);
    },
    publish: (o, e) => {
      events.push([o, e]);
    },
  });
  function panel(n = authorities.length + 1, sourceKey = "test-source") {
    const owner: ResourceOwner = {
      sourceKey,
      pluginId: "test.lab",
      generation: 1,
      hostEpoch: uuid(100),
      processEpoch: uuid(101),
    };
    const binding: Binding = {
      contributionId: "test.lab.panel",
      panelInstance: uuid(n),
      kind: "panel",
      uiResourceGeneration: 1,
      generation: 1,
      hostEpoch: owner.hostEpoch,
      processEpoch: owner.processEpoch,
    };
    const a: UiDataAuthority = {
      owner,
      binding,
      registration: {},
      version: 2,
      ready: true,
      panelsPermission: true,
      visible: true,
      presentation: 0,
      resource: {
        kind: "panel",
        root: "root",
        nodes: [{ id: "root", type: "group", layout: "stack", children: [] }],
        fields: {},
        data: {
          presentation: {
            schema: {
              type: "number",
              min: 0,
              max: Number.MAX_SAFE_INTEGER,
              integer: true,
              nullable: false,
            },
            initial: 0,
          },
        },
        presentationKey: "presentation",
        datasets: { code: { kind: "code" } },
      },
    };
    authorities.push(a);
    return { owner, binding, a };
  }
  return {
    store,
    panel,
    events,
    authorities,
    time: (n: number) => {
      now = n;
    },
    admit: (f: UiDataStorePorts["admitCommit"]) => {
      admission = f;
    },
    calls: () => calls,
  };
}
type H = ReturnType<typeof harness>;
type P = ReturnType<H["panel"]>;
function begin(h: H, p: P, f = fixture(), dataset = "code", baseRevision = 0, presentation = 1) {
  const { header, entryCount, byteLength, sha256 } = f;
  const metadata = { header, entryCount, byteLength, sha256 };
  return ok(
    h.store.begin(p.owner, {
      binding: p.binding,
      dataset,
      baseRevision,
      presentation,
      ...metadata,
    }),
  ).transfer;
}
function send(h: H, p: P, transfer: string, f = fixture(), dataset = "code", chunkSize = 7) {
  for (let offset = 0; offset < f.entries.length; offset += chunkSize) {
    ok(
      h.store.chunk(p.owner, {
        binding: p.binding,
        dataset,
        transfer,
        offset,
        chunk: {
          kind: f.header.kind,
          entries: f.entries.slice(offset, offset + chunkSize),
        } as DatasetChunkV2,
      }),
    );
  }
}
function upload(h: H, p: P, f = fixture(), dataset = "code", baseRevision = 0, presentation = 1) {
  const transfer = begin(h, p, f, dataset, baseRevision, presentation);
  send(h, p, transfer, f, dataset);
  return {
    transfer,
    metadata: ok(h.store.commit(p.owner, { binding: p.binding, dataset, transfer })),
  };
}
function read(h: H, p: P, revision = 1, offset = 0, limit = 256, dataset = "code") {
  return h.store.read(p.owner, { binding: p.binding, dataset, revision, offset, limit });
}
const tableDeclaration: DatasetDeclarationV2 = {
  kind: "table",
  columns: Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    label: { en: `C${i}` },
    value: "string" as const,
  })),
};
function largeTable() {
  return fixture(
    { kind: "table" },
    Array.from({ length: 50 }, (_, i) => ({
      key: `row${i}`,
      version: null,
      cells: Array.from({ length: 8 }, () => "😀".repeat(200)),
    })),
  );
}
describe("isolated UI v2 data store", () => {
  it("atomically replaces complete datasets, publishes metadata, copies inputs/results, and reconciles receipts", () => {
    const h = harness(),
      p = h.panel(),
      f = fixture();
    const t = begin(h, p, f);
    send(h, p, t, f);
    (f.entries as string[])[0] = "mutated";
    expect(ok(h.store.snapshot(p.owner, { binding: p.binding })).datasets).toEqual([]);
    const q = { binding: p.binding, dataset: "code", transfer: t };
    const first = ok(h.store.commit(p.owner, q));
    expect(first.revision).toBe(1);
    expect(ok(h.store.commit(p.owner, q))).toEqual(first);
    expect(h.calls()).toBe(1);
    expect(h.events).toHaveLength(1);
    expect(Object.keys(h.events[0]![1].data).sort()).toEqual([
      "binding",
      "dataset",
      "presentation",
      "revision",
    ]);
    const page = ok(read(h, p));
    expect(page.chunk.entries).toEqual(["one", "two"]);
    page.chunk.entries.length = 0;
    first.sha256 = "0".repeat(64);
    expect(ok(read(h, p)).chunk.entries).toEqual(["one", "two"]);
    upload(h, p, fixture({ kind: "code" }, ["replacement"]), "code", 1, 2);
    rejected(read(h, p), "revision");
    expect(ok(read(h, p, 2)).chunk.entries).toEqual(["replacement"]);
    expect(ok(h.store.abort(p.owner, q))).toEqual({ aborted: false });
    expect(
      uiDataRequestSchemasV2["ui/dataSnapshot"].result.safeParse(
        h.store.snapshot(p.owner, { binding: p.binding }),
      ).success,
    ).toBe(true);
  });
  it("only replays the last identical canonical chunk, with no idle TTL renewal", () => {
    const h = harness(),
      p = h.panel(),
      t = begin(h, p);
    const q = {
      binding: p.binding,
      dataset: "code",
      transfer: t,
      offset: 0,
      chunk: { kind: "code" as const, entries: ["one"] },
    };
    ok(h.store.chunk(p.owner, q));
    h.time(4900);
    expect(ok(h.store.chunk(p.owner, q)).remainingMs).toBe(100);
    rejected(h.store.chunk(p.owner, { ...q, chunk: { kind: "code", entries: ["two"] } }), "offset");
    rejected(h.store.chunk(p.owner, { ...q, offset: 2 }), "offset");
    ok(h.store.chunk(p.owner, { ...q, offset: 1, chunk: { kind: "code", entries: ["two"] } }));
    rejected(h.store.chunk(p.owner, q), "offset");
    h.time(9900);
    rejected(
      h.store.commit(p.owner, { binding: p.binding, dataset: "code", transfer: t }),
      "stale",
    );
  });
  it("caps absolute lifetime at ten seconds even with accepted progress", () => {
    const h = harness(),
      p = h.panel(),
      f = fixture({ kind: "code" }, ["a", "b", "c"]),
      t = begin(h, p, f);
    for (const [offset, time] of [4000, 8000, 9999].entries()) {
      h.time(time);
      const r = ok(
        h.store.chunk(p.owner, {
          binding: p.binding,
          dataset: "code",
          transfer: t,
          offset,
          chunk: { kind: "code", entries: [(f.entries as string[])[offset]!] },
        }),
      );
      expect(r.remainingMs).toBe(Math.min(5000, 10000 - time));
    }
    h.time(10000);
    h.store.sweep();
    rejected(
      h.store.commit(p.owner, { binding: p.binding, dataset: "code", transfer: t }),
      "stale",
    );
    begin(h, p, f); // Reservation released.
  });
  it.each(["hash", "count", "bytes"])(
    "aborts %s mismatch while retaining the old revision",
    (mode) => {
      const h = harness(),
        p = h.panel();
      upload(h, p);
      const f = fixture({ kind: "code" }, ["new"]);
      if (mode === "hash") f.sha256 = "0".repeat(64);
      if (mode === "count") f.entryCount++;
      if (mode === "bytes") f.byteLength++;
      const t = begin(h, p, f, "code", 1, 2);
      send(h, p, t, f);
      const q = { binding: p.binding, dataset: "code", transfer: t };
      rejected(h.store.commit(p.owner, q), "checksum");
      expect(ok(h.store.abort(p.owner, q)).aborted).toBe(false);
      expect(ok(read(h, p)).chunk.entries).toEqual(["one", "two"]);
      expect(h.events).toHaveLength(1);
    },
  );
  it("rejects cross-chunk duplicate rows and header/declaration references", () => {
    const h = harness(),
      p = h.panel();
    p.a.resource.datasets.table = tableDeclaration;
    const f = largeTable(),
      t = begin(h, p, f, "table");
    const q = {
      binding: p.binding,
      dataset: "table",
      transfer: t,
      offset: 0,
      chunk: {
        kind: "table" as const,
        entries: (f.entries as Extract<DatasetChunkV2, { kind: "table" }>["entries"]).slice(0, 1),
      },
    };
    ok(h.store.chunk(p.owner, q));
    rejected(h.store.chunk(p.owner, { ...q, offset: 1 }), "schema");
    rejected(
      h.store.commit(p.owner, { binding: p.binding, dataset: "table", transfer: t }),
      "stale",
    );
    const { header, entryCount, byteLength, sha256 } = fixture();
    const meta = { header, entryCount, byteLength, sha256 };
    rejected(
      h.store.begin(p.owner, {
        ...meta,
        binding: p.binding,
        dataset: "table",
        baseRevision: 0,
        presentation: 1,
      }),
      "reference",
    );
  });
  it("requires exact trusted owner and all binding fields, and rejects unready/version/permission", () => {
    const h = harness(),
      p = h.panel(),
      t = begin(h, p);
    const q = { binding: p.binding, dataset: "code", transfer: t };
    const ownerChanges: Partial<ResourceOwner>[] = [
      { sourceKey: "foreign" },
      { pluginId: "other.plugin" },
      { generation: 2 },
      { hostEpoch: uuid(200) },
      { processEpoch: uuid(201) },
    ];
    for (const change of ownerChanges)
      rejected(h.store.abort({ ...p.owner, ...change }, q), "stale");
    const bindingChanges: Partial<Binding>[] = [
      { contributionId: "test.lab.other" },
      { panelInstance: uuid(200) },
      { uiResourceGeneration: 2 },
      { generation: 2 },
      { hostEpoch: uuid(200) },
      { processEpoch: uuid(201) },
    ];
    for (const change of bindingChanges)
      rejected(h.store.abort(p.owner, { ...q, binding: { ...p.binding, ...change } }), "stale");
    expect(() =>
      h.store.abort(p.owner, { ...q, binding: { ...p.binding, kind: "status" } } as never),
    ).toThrow(UiDataInvalidParamsError);
    p.a.ready = false;
    rejected(h.store.abort(p.owner, q), "stale");
    p.a.ready = true;
    p.a.version = 1;
    rejected(h.store.abort(p.owner, q), "version");
    p.a.version = 2;
    p.a.panelsPermission = false;
    rejected(h.store.abort(p.owner, q), "permission");
    p.a.panelsPermission = true;
    expect(ok(h.store.abort(p.owner, q)).aborted).toBe(true);
  });
  it("rejects another legitimate owner probing a transfer with the same public binding", () => {
    const h = harness(),
      p = h.panel(),
      t = begin(h, p),
      foreign = h.panel(1, "other-source");
    const q = { binding: foreign.binding, dataset: "code", transfer: t };
    const unknown = h.store.abort(foreign.owner, { ...q, transfer: uuid(444) });
    expect(h.store.abort(foreign.owner, q)).toEqual(unknown);
    expect(ok(h.store.snapshot(foreign.owner, { binding: foreign.binding })).datasets).toEqual([]);
    send(h, p, t);
    ok(h.store.commit(p.owner, { ...q, binding: p.binding }));
  });
  it("rechecks visible presentation, shared rate admission, and lifetime at commit", () => {
    const h = harness(),
      p = h.panel(),
      t = begin(h, p);
    send(h, p, t);
    const q = { binding: p.binding, dataset: "code", transfer: t };
    p.a.presentation = 1;
    rejected(h.store.commit(p.owner, q), "revision");
    p.a.presentation = 0;
    h.admit(() => "rate");
    rejected(h.store.commit(p.owner, q), "rate");
    h.admit(() => "queue");
    rejected(h.store.commit(p.owner, q), "queue");
    h.admit(() => {
      p.a.presentation = 1;
      return "admitted";
    });
    rejected(h.store.commit(p.owner, q), "revision");
    p.a.presentation = 0;
    h.admit(() => {
      h.time(5000);
      return "admitted";
    });
    rejected(h.store.commit(p.owner, q), "stale");
    expect(h.events).toHaveLength(0);
  });
  it.each(["hide", "close", "owner", "host", "resource"])(
    "prevents late commit publication after %s",
    (hook) => {
      const h = harness(),
        p = h.panel();
      upload(h, p);
      const t = begin(h, p, fixture(), "code", 1, 2);
      send(h, p, t);
      h.admit(() => {
        if (hook === "hide") {
          p.a.visible = false;
          h.store.invalidateHide(p.owner, p.binding);
        }
        if (hook === "close") h.store.close(p.owner, p.binding);
        if (hook === "owner") h.store.retire(p.owner);
        if (hook === "host") h.store.retireHost(p.owner.hostEpoch);
        if (hook === "resource") p.a.registration = {};
        return "admitted";
      });
      rejected(
        h.store.commit(p.owner, { binding: p.binding, dataset: "code", transfer: t }),
        "stale",
      );
      expect(h.events).toHaveLength(1);
      expect(ok(h.store.snapshot(p.owner, { binding: p.binding })).datasets).toHaveLength(
        hook === "hide" ? 1 : 0,
      );
    },
  );
  it("hide retains committed data and aborts staging; reopening starts at revision zero", () => {
    const h = harness(),
      p = h.panel();
    const committed = upload(h, p);
    const t = begin(h, p, fixture(), "code", 1, 2);
    h.store.invalidateHide(p.owner, p.binding);
    p.a.visible = false;
    expect(
      ok(
        h.store.commit(p.owner, {
          binding: p.binding,
          dataset: "code",
          transfer: committed.transfer,
        }),
      ),
    ).toEqual(committed.metadata);
    expect(ok(read(h, p)).revision).toBe(1);
    expect(
      ok(h.store.abort(p.owner, { binding: p.binding, dataset: "code", transfer: t })).aborted,
    ).toBe(false);
    h.store.close(p.owner, p.binding);
    h.authorities.splice(0, 1);
    rejected(read(h, p), "stale");
    const reopened = h.panel(2);
    expect(upload(h, reopened).metadata.revision).toBe(1);
    h.store.retire({ ...p.owner, generation: 2 });
    expect(ok(read(h, reopened)).revision).toBe(1);
  });
  it("retains only four payload-free terminal receipts until created+30 seconds", () => {
    const h = harness(),
      p = h.panel(),
      transfers: string[] = [];
    for (let i = 0; i < 5; i++) transfers.push(upload(h, p, fixture(), "code", i, i + 1).transfer);
    rejected(
      h.store.commit(p.owner, { binding: p.binding, dataset: "code", transfer: transfers[0]! }),
      "stale",
    );
    const q = { binding: p.binding, dataset: "code", transfer: transfers[1]! };
    h.time(29999);
    expect(ok(h.store.commit(p.owner, q)).revision).toBe(2);
    h.time(30000);
    rejected(h.store.commit(p.owner, q), "stale");
    expect(ok(read(h, p, 5)).chunk.entries).toEqual(["one", "two"]);
    expect(h.calls()).toBe(5);
  });
  it("shrinks complete business pages by whole entries with progress and empty EOF", () => {
    const h = harness(),
      p = h.panel(),
      f = fixture(
        { kind: "code" },
        Array.from({ length: 16 }, () => "\u0001".repeat(1024)),
      );
    upload(h, p, f);
    let offset = 0;
    const collected: unknown[] = [];
    while (offset < f.entries.length) {
      const value = ok(read(h, p, 1, offset));
      expect(Buffer.byteLength(JSON.stringify({ ok: true, value }))).toBeLessThanOrEqual(49152);
      expect(value.nextOffset).toBeGreaterThan(offset);
      collected.push(...value.chunk.entries);
      offset = value.nextOffset;
    }
    expect(collected).toEqual(f.entries);
    expect(ok(read(h, p, 1, offset))).toMatchObject({
      chunk: { entries: [] },
      nextOffset: offset,
      done: true,
    });
    rejected(read(h, p, 1, offset + 1), "offset");
  });
  it("reserves full source/host receiving bytes at begin and releases on abort/expiry", () => {
    const h = harness();
    const p = h.panel(),
      f = { ...fixture(), byteLength: 524288 },
      t = begin(h, p, f);
    const other = h.panel();
    const request = {
      binding: other.binding,
      dataset: "code",
      baseRevision: 0,
      presentation: 1,
      header: f.header,
      entryCount: f.entryCount,
      byteLength: f.byteLength,
      sha256: f.sha256,
    };
    rejected(h.store.begin(other.owner, request), "quota");
    rejected(h.store.begin(p.owner, { ...request, binding: p.binding }), "quota");
    for (let i = 0; i < 3; i++) begin(h, h.panel(10 + i, `source-${i}`), f);
    const excess = h.panel(20, "excess");
    rejected(h.store.begin(excess.owner, { ...request, binding: excess.binding }), "quota");
    ok(h.store.abort(p.owner, { binding: p.binding, dataset: "code", transfer: t }));
    begin(h, other, f);
    h.time(5000);
    h.store.sweep();
    begin(h, excess, f);
  });
  it("uses projected panel bytes including replacement subtraction and rechecks at commit", () => {
    const h = harness(),
      p = h.panel(),
      f = largeTable();
    p.a.resource.datasets = { a: tableDeclaration, b: tableDeclaration };
    upload(h, p, f, "a");
    upload(h, p, f, "a", 1, 2);
    const { header, entryCount, byteLength, sha256 } = f;
    const meta = { header, entryCount, byteLength, sha256 };
    rejected(
      h.store.begin(p.owner, {
        ...meta,
        binding: p.binding,
        dataset: "b",
        baseRevision: 0,
        presentation: 3,
      }),
      "quota",
    );
    expect(ok(h.store.snapshot(p.owner, { binding: p.binding })).datasets).toHaveLength(1);
  });
  it("enforces source committed quota again when other panels commit after begin", () => {
    const h = harness(),
      f = largeTable();
    const count = Math.floor(2097152 / f.byteLength);
    for (let i = 0; i < count - 1; i++) {
      const p = h.panel();
      p.a.resource.datasets = { table: tableDeclaration };
      upload(h, p, f, "table");
    }
    const pending = h.panel();
    pending.a.resource.datasets = { table: tableDeclaration };
    const partial = fixture({ kind: "table" }, f.entries.slice(0, 30) as DatasetChunkV2["entries"]);
    expect(partial.byteLength + f.byteLength).toBeLessThanOrEqual(524288);
    expect(count * f.byteLength + partial.byteLength).toBeGreaterThan(2097152);
    const t = begin(h, pending, partial, "table");
    send(h, pending, t, partial, "table");
    // Begin admitted both projections independently; the other commit consumes
    // the capacity before this transfer attempts its atomic replacement.
    const other = h.panel();
    other.a.resource.datasets = { table: tableDeclaration };
    upload(h, other, f, "table");
    rejected(
      h.store.commit(pending.owner, { binding: pending.binding, dataset: "table", transfer: t }),
      "quota",
    );
    expect(ok(h.store.snapshot(pending.owner, { binding: pending.binding })).datasets).toEqual([]);
    h.store.close(other.owner, other.binding);
    ok(h.store.commit(pending.owner, { binding: pending.binding, dataset: "table", transfer: t }));
  });
  it("enforces host committed bytes across distinct sources", () => {
    const h = harness(),
      f = largeTable(),
      count = Math.floor(8388608 / f.byteLength);
    for (let i = 0; i < count; i++) {
      const p = h.panel(i + 1, `source-${i}`);
      p.a.resource.datasets = { table: tableDeclaration };
      upload(h, p, f, "table");
    }
    const p = h.panel(1000, "excess");
    p.a.resource.datasets = { table: tableDeclaration };
    const { header, entryCount, byteLength, sha256 } = f;
    const meta = { header, entryCount, byteLength, sha256 };
    rejected(
      h.store.begin(p.owner, {
        ...meta,
        binding: p.binding,
        dataset: "table",
        baseRevision: 0,
        presentation: 1,
      }),
      "quota",
    );
  });
  it("checks complete chart ordering across chunk boundaries and preserves typed time-domain/view", () => {
    const h = harness(),
      p = h.panel();
    p.a.resource.datasets = {
      chart: { kind: "chart", series: [{ id: "sensor", label: { en: "Sensor" } }] },
    };
    const f = fixture(
      {
        kind: "chart",
        timeDomain: [0, 1000],
        view: "recent60s",
        series: [
          {
            id: "sensor",
            unit: "m",
            range: [0, 3],
            extrema: [
              [0, 1],
              [1000, 2],
            ],
            fullPointCount: 2,
            omittedPoints: 0,
            omittedRuns: 0,
          },
        ],
      },
      [
        [0, 0, 0, 1],
        [0, 0, 1000, 2],
      ],
    );
    const t = begin(h, p, f, "chart");
    for (const offset of [0, 1])
      ok(
        h.store.chunk(p.owner, {
          binding: p.binding,
          dataset: "chart",
          transfer: t,
          offset,
          chunk: {
            kind: "chart",
            entries: [(f.entries as [number, number, number, number][])[1 - offset]!],
          },
        }),
      );
    rejected(
      h.store.commit(p.owner, { binding: p.binding, dataset: "chart", transfer: t }),
      "schema",
    );
    upload(h, p, f, "chart");
    expect(ok(read(h, p, 1, 1, 1, "chart"))).toMatchObject({
      header: { timeDomain: [0, 1000], view: "recent60s" },
      chunk: { entries: [[0, 0, 1000, 2]] },
      nextOffset: 2,
      done: true,
    });
  });
  it("bounds declared datasets and emits eight unique metadata records without payloads", () => {
    const h = harness(),
      p = h.panel();
    p.a.resource.datasets = {};
    const empty = fixture({ kind: "table" }, []);
    for (let i = 0; i < 8; i++) p.a.resource.datasets[`d${i}`] = tableDeclaration;
    for (let i = 0; i < 8; i++) upload(h, p, empty, `d${i}`);
    const snapshot = ok(h.store.snapshot(p.owner, { binding: p.binding }));
    expect(snapshot.datasets).toHaveLength(8);
    expect(new Set(snapshot.datasets.map((d) => d.dataset)).size).toBe(8);
    expect(Object.keys(snapshot.datasets[0]!).sort()).toEqual([
      "byteLength",
      "dataset",
      "presentation",
      "revision",
      "sha256",
    ]);
    p.a.resource.datasets.d8 = tableDeclaration;
    const { header, entryCount, byteLength, sha256 } = empty;
    const meta = { header, entryCount, byteLength, sha256 };
    rejected(
      h.store.begin(p.owner, {
        ...meta,
        binding: p.binding,
        dataset: "d8",
        baseRevision: 0,
        presentation: 1,
      }),
      "quota",
    );
  });
  it("aborts a structurally valid chunk exceeding the canonical page budget", () => {
    const h = harness(),
      p = h.panel();
    const f = fixture(
      { kind: "code" },
      Array.from({ length: 16 }, () => "\u0001".repeat(1024)),
    );
    const transfer = begin(h, p, f);
    const q = { binding: p.binding, dataset: "code", transfer };
    rejected(
      h.store.chunk(p.owner, {
        ...q,
        offset: 0,
        chunk: { kind: "code", entries: (f.entries as string[]).slice(0, 9) },
      }),
      "quota",
    );
    expect(ok(h.store.abort(p.owner, q)).aborted).toBe(false);
    begin(h, p, f);
  });
  it("checks actual raw frame size before parsing and distinguishes invalid parameters", () => {
    const h = harness(),
      p = h.panel();
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: "request",
      method: "ui/dataSnapshot",
      params: { binding: p.binding },
    });
    const reply = JSON.parse(h.store.requestFrame(p.owner, frame));
    expect(reply).toMatchObject({ id: "request", result: { ok: true, value: { datasets: [] } } });
    expect(() => h.store.requestFrame(p.owner, " ".repeat(65536) + frame)).toThrow();
    expect(() => h.store.requestFrame(p.owner, new Uint8Array(65537))).toThrow();
    expect(() => h.store.requestFrame(p.owner, new Uint8Array([0xff]))).toThrow(
      UiDataRpcBoundaryError,
    );
    expect(() =>
      h.store.requestFrame(p.owner, frame.replace('"binding":', '"extra":true,"binding":')),
    ).toThrow(UiDataInvalidParamsError);
    expect(() =>
      h.store.begin(p.owner, { binding: p.binding, dataset: "code", baseRevision: NaN } as never),
    ).toThrow(UiDataInvalidParamsError);
  });
});
