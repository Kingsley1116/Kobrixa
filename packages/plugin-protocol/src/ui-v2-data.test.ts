import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  datasetDeclarationV2Schema,
  datasetHeaderV2Schema,
  datasetChunkV2Schema,
  datasetV2Schema,
  validateDatasetDeclarationV2,
  validateDatasetHeaderV2,
  validateDatasetChunkV2,
  validateDatasetV2,
  validateDatasetPanelV2,
  canonicalDatasetV2Json,
  canonicalDatasetV2Bytes,
  canonicalHeaderV2Json,
  canonicalChunkV2Json,
  chartTimeDomainsMatchV2,
  effectiveTimeDomainV2,
  UiDataValidationErrorV2,
} from "./ui-v2-data.js";
import type {
  DatasetDeclarationV2,
  ChartHeaderV2,
  DatasetPointV2,
  DatasetRowV2,
} from "./ui-v2-data.js";
const chartDeclaration: DatasetDeclarationV2 = {
  kind: "chart",
  series: [0, 1].map((i) => ({ id: `s${i}`, label: { en: `Series ${i}` } })),
};
function chartHeader(): ChartHeaderV2 {
  return {
    kind: "chart",
    timeDomain: [0, 1800000],
    view: "full",
    series: [0, 1].map((i) => ({
      id: `s${i}`,
      unit: "deg",
      range: [-100, 100],
      extrema: [
        [0, -100],
        [500, 100],
      ],
      fullPointCount: 3600,
      omittedPoints: 2800,
      omittedRuns: 0,
    })),
  };
}
const chartPoints = (): DatasetPointV2[] =>
  Array.from({ length: 1600 }, (_, i) => [
    Math.floor(i / 800),
    0,
    (i % 800) * 500,
    i % 2 ? 100 : -100,
  ]);
function declaration(
  kind: "table" | "list",
  n: number,
  value: "string" | "number" | "boolean" = "string",
): DatasetDeclarationV2 {
  return {
    kind,
    columns: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      label: { en: `Column ${i}` },
      value,
    })),
  };
}
const rows = (n: number, cell: string): DatasetRowV2[] =>
  Array.from({ length: 50 }, (_, i) => ({
    key: `row-${i}`,
    version: "00000000-0000-4000-8000-000000000001",
    cells: Array(n).fill(cell),
  }));
const golden = JSON.parse(
  readFileSync(
    new URL("../../../test-fixtures/declarative-ui-v2/data/canonical-golden.json", import.meta.url),
    "utf8",
  ),
) as { name: string; canonical: string; byteLength: number; sha256: string }[];
const fails = (fn: () => unknown, reason?: string) => {
  expect(fn).toThrow(UiDataValidationErrorV2);
  if (reason) {
    try {
      fn();
    } catch (e) {
      expect(e).toMatchObject({ reason });
    }
  }
};

describe("exportable wire shapes and explicit semantic admission", () => {
  it("exports all composed schemas without custom refinements", () => {
    for (const schema of [
      datasetDeclarationV2Schema,
      datasetHeaderV2Schema,
      datasetChunkV2Schema,
      datasetV2Schema,
    ]) {
      const exported = z.toJSONSchema(schema);
      expect(JSON.stringify(exported)).toContain('"additionalProperties":false');
      expect(JSON.stringify(exported)).not.toContain('"type":"any"');
    }
  });
  it("keeps cross-field checks explicit and rejects unknown variants/fields", () => {
    const h = chartHeader();
    h.series[0]!.range = [1, -1];
    expect(datasetHeaderV2Schema.safeParse(h).success).toBe(true);
    fails(() => validateDatasetHeaderV2(h));
    for (const h of [
      { ...chartHeader(), extra: 1 },
      { kind: "other" },
      { kind: "code", series: [] },
    ])
      fails(() => validateDatasetHeaderV2(h));
    fails(() => validateDatasetV2({ kind: "code" }, { kind: "table" }, []), "reference");
    fails(() => validateDatasetChunkV2({ kind: "code", entries: [42] }));
  });
  it("validates declaration cardinality, labels, IDs, and order", () => {
    expect(validateDatasetDeclarationV2(chartDeclaration)).toEqual(chartDeclaration);
    fails(() => validateDatasetDeclarationV2({ kind: "chart", series: [] }));
    fails(() =>
      validateDatasetDeclarationV2({
        ...chartDeclaration,
        series: [...chartDeclaration.series, chartDeclaration.series[0]],
      }),
    );
    fails(() => validateDatasetDeclarationV2(declaration("table", 9)));
    fails(() => validateDatasetDeclarationV2(declaration("list", 4)));
    const d = { kind: "chart", series: [{ id: "s", label: { en: "😀".repeat(200) } }] };
    expect(validateDatasetDeclarationV2(d)).toEqual(d);
    fails(() =>
      validateDatasetDeclarationV2({
        ...d,
        series: [{ id: "s", label: { en: "😀".repeat(201) } }],
      }),
    );
    fails(() =>
      validateDatasetDeclarationV2({ ...d, series: [{ id: "constructor", label: { en: "Bad" } }] }),
    );
    fails(
      () => validateDatasetDeclarationV2({ ...d, series: [...d.series, ...d.series] }),
      "reference",
    );
    const h = chartHeader();
    h.series.reverse();
    fails(() => validateDatasetHeaderV2(h, chartDeclaration), "reference");
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite %s before canonical JSON can turn it into null",
    (n) => {
      fails(() =>
        canonicalDatasetV2Json({ kind: "table" }, [{ key: "n", version: null, cells: [n] }]),
      );
      const h = chartHeader();
      h.timeDomain[1] = n;
      fails(() => canonicalHeaderV2Json(h));
    },
  );
  it.each(["\ud800", "\udfff", "x\ud800y", "\0"])("rejects invalid Unicode/NUL %j", (s) => {
    fails(() => canonicalDatasetV2Json({ kind: "code" }, [s]));
    fails(() =>
      validateDatasetChunkV2({ kind: "table", entries: [{ key: s, version: null, cells: [] }] }),
    );
    const h = chartHeader();
    h.series[0]!.unit = s;
    fails(() => validateDatasetHeaderV2(h));
  });
  it("rejects original dangerous keys and custom prototypes", () => {
    for (const key of ["__proto__", "constructor", "prototype"])
      fails(() => canonicalDatasetV2Json(JSON.parse(`{"kind":"code","${key}":{}}`), []));
    fails(() =>
      validateDatasetHeaderV2(Object.assign(Object.create({ hidden: true }), { kind: "code" })),
    );
  });
});

describe("canonical golden vectors", () => {
  it.each(golden)("$name has fixed UTF-8 bytes and SHA-256", (vector) => {
    const [header, entries] = JSON.parse(vector.canonical);
    if (vector.name === "numbers") entries[0].cells[0] = -0;
    const actual = canonicalDatasetV2Bytes(header, entries);
    expect(canonicalDatasetV2Json(header, entries)).toBe(vector.canonical);
    expect(actual.byteLength).toBe(vector.byteLength);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(vector.sha256);
  });
  it("rebuilds nested key order, preserves Unicode normalization and does not mutate", () => {
    const h = chartHeader();
    const reversed = {
      series: h.series.map((s) => Object.fromEntries(Object.entries(s).reverse())),
      view: h.view,
      timeDomain: h.timeDomain,
      kind: h.kind,
    };
    expect(canonicalDatasetV2Json(reversed, chartPoints())).toBe(
      canonicalDatasetV2Json(h, chartPoints()),
    );
    const row = { cells: ["臺😀"], version: null, key: "row" };
    expect(canonicalDatasetV2Json({ kind: "table" }, [row])).toBe(
      '[{"kind":"table"},[{"key":"row","version":null,"cells":["臺😀"]}]]',
    );
    expect(Object.keys(row)).toEqual(["cells", "version", "key"]);
    expect(canonicalDatasetV2Json({ kind: "code" }, ["é"])).not.toBe(
      canonicalDatasetV2Json({ kind: "code" }, ["é"]),
    );
  });
});

describe("chart semantics and time domains", () => {
  it("accepts the exact T0 maximum point recipe and rejects 801 per series", () => {
    expect(validateDatasetV2(chartDeclaration, chartHeader(), chartPoints()).entries).toHaveLength(
      1600,
    );
    const h = chartHeader(),
      p = chartPoints();
    p.splice(800, 0, [0, 0, 400000, 0]);
    h.series[0]!.omittedPoints--;
    fails(() => validateDatasetV2(chartDeclaration, h, p));
  });
  it("checks cross-chunk order, references, counts, extrema and range", () => {
    const cases: Array<(h: ChartHeaderV2, p: DatasetPointV2[]) => void> = [
      (_h, p) => {
        p[500]![0] = 2;
      },
      (_h, p) => {
        p[500]![1] = -1;
      },
      (_h, p) => {
        p[500]![2] = 0;
      },
      (_h, p) => {
        p[500]![3] = 101;
      },
      (h) => {
        h.series[0]!.omittedPoints--;
      },
      (h) => {
        h.series[0]!.extrema = null;
      },
      (h) => {
        h.series[0]!.extrema![1] = [1800001, 100];
      },
      (h) => {
        h.series[0]!.extrema![1] = [501, 100];
      },
      (h) => {
        h.series[0]!.omittedRuns = 2801;
      },
    ];
    for (const mutate of cases) {
      const h = chartHeader(),
        p = chartPoints();
      mutate(h, p);
      fails(() => validateDatasetV2(chartDeclaration, h, p));
    }
    const p = chartPoints();
    p[500]![1] = 1; // later reset to run0 is invalid across a chunk boundary
    fails(() => validateDatasetV2(chartDeclaration, chartHeader(), p));
  });
  it("allows decreasing time only at a new run, and duplicate timestamps", () => {
    const h = chartHeader();
    h.series = [{ ...h.series[0]!, fullPointCount: 3, omittedPoints: 0 }];
    const d = { kind: "chart" as const, series: [chartDeclaration.series[0]!] };
    expect(
      validateDatasetV2(d, h, [
        [0, 0, 0, -100],
        [0, 0, 500, 100],
        [0, 1, 0, -100],
      ]).entries,
    ).toHaveLength(3);
    expect(
      validateDatasetV2(d, h, [
        [0, 0, 0, -100],
        [0, 0, 500, 100],
        [0, 0, 500, 100],
      ]).entries,
    ).toHaveLength(3);
  });
  it("retains empty and trailing-null spans and derives recent windows from the header", () => {
    const h = chartHeader();
    h.series.forEach((s) => {
      s.fullPointCount = 0;
      s.omittedPoints = 0;
      s.extrema = null;
    });
    expect(validateDatasetV2(chartDeclaration, h, []).entries).toEqual([]);
    expect(effectiveTimeDomainV2(h, "recent60s")).toEqual([1740000, 1800000]);
    expect(effectiveTimeDomainV2(h, "full")).toEqual([0, 1800000]);
    for (const end of [1000, 59999, 60000, 60001]) {
      h.timeDomain = [0, end];
      expect(effectiveTimeDomainV2(h, "recent60s")).toEqual([Math.max(0, end - 60000), end]);
    }
    for (const domain of [
      [1, 1000],
      [0, 999],
      [0, -1],
    ])
      fails(() => validateDatasetHeaderV2({ ...h, timeDomain: domain }));
    const long = chartHeader();
    expect(chartTimeDomainsMatchV2([long, structuredClone(long)])).toBe(true);
    expect(chartTimeDomainsMatchV2([long, { ...long, view: "recent60s" }])).toBe(false);
    expect(chartTimeDomainsMatchV2([long, { ...long, timeDomain: [0, 1800001] }])).toBe(false);
    expect(chartTimeDomainsMatchV2([])).toBe(false);
  });
});

describe("rows, code, chunks and actual budgets", () => {
  it("checks rows 49/50/51, code-point strings, duplicate keys and declared cell types", () => {
    const d = declaration("table", 8),
      r = rows(8, "😀".repeat(200));
    for (const count of [49, 50])
      expect(validateDatasetV2(d, { kind: "table" }, r.slice(0, count)).entries).toHaveLength(
        count,
      );
    fails(() => validateDatasetV2(d, { kind: "table" }, [...r, { ...r[0], key: "51" }]));
    fails(() => validateDatasetV2(d, { kind: "table" }, [r[0], r[0]]), "reference");
    fails(() => validateDatasetV2(d, { kind: "table" }, [{ ...r[0], cells: ["😀".repeat(201)] }]));
    fails(
      () =>
        validateDatasetV2(declaration("table", 1, "number"), { kind: "table" }, [
          { key: "r", version: null, cells: ["1"] },
        ]),
      "reference",
    );
    expect(
      validateDatasetV2(declaration("table", 1, "number"), { kind: "table" }, [
        { key: "r", version: null, cells: [null] },
      ]).entries,
    ).toHaveLength(1);
    for (const key of ["", "x".repeat(129)])
      fails(() => canonicalDatasetV2Json({ kind: "table" }, [{ key, version: null, cells: [] }]));
  });
  it("enforces code entry and total scalar counts plus escaped canonical bytes", () => {
    for (const n of [1023, 1024])
      expect(
        validateDatasetChunkV2({ kind: "code", entries: ["😀".repeat(n)] }).entries,
      ).toHaveLength(1);
    fails(() => validateDatasetChunkV2({ kind: "code", entries: ["😀".repeat(1025)] }));
    for (const n of [16383, 16384]) {
      const entries = Array.from({ length: Math.ceil(n / 1024) }, (_, i) =>
        "😀".repeat(Math.min(1024, n - i * 1024)),
      );
      expect(validateDatasetV2({ kind: "code" }, { kind: "code" }, entries).entries).toHaveLength(
        16,
      );
    }
    fails(
      () =>
        validateDatasetV2({ kind: "code" }, { kind: "code" }, [
          ...Array(16).fill("x".repeat(1024)),
          "x",
        ]),
      "quota",
    );
    fails(() => validateDatasetChunkV2({ kind: "code", entries: [""] }));
    // 6 JSON bytes per control scalar: raw UTF-8 length is not the chunk budget.
    fails(
      () => validateDatasetChunkV2({ kind: "code", entries: Array(9).fill("\x01".repeat(1024)) }),
      "quota",
    );
  });
  it("enforces 255/256/257 chunk entries and canonical chunk bytes", () => {
    for (const n of [255, 256])
      expect(
        validateDatasetChunkV2(
          { kind: "chart", entries: chartPoints().slice(0, n) },
          chartHeader(),
          chartDeclaration,
        ).entries,
      ).toHaveLength(n);
    fails(() => validateDatasetChunkV2({ kind: "chart", entries: chartPoints().slice(0, 257) }));
    fails(() => validateDatasetChunkV2({ kind: "chart", entries: chartPoints() }));
    const large = rows(8, "臺".repeat(200));
    expect(
      validateDatasetChunkV2({ kind: "table", entries: large.slice(0, 10) }).entries,
    ).toHaveLength(10);
    fails(() => validateDatasetChunkV2({ kind: "table", entries: large.slice(0, 11) }), "quota");
    expect(canonicalChunkV2Json({ entries: ["臺"], kind: "code" })).toBe(
      '{"kind":"code","entries":["臺"]}',
    );
  });
  it("hits exact 49152 chunk bytes then rejects 49153", () => {
    // 48*1024 minus JSON overhead, with <=1024 chars per entry.
    const entries = Array(48).fill("x".repeat(1024));
    const overhead = Buffer.byteLength(JSON.stringify({ kind: "code", entries }));
    entries[47] = "x".repeat(1024 - (overhead - 49152));
    expect(Buffer.byteLength(canonicalChunkV2Json({ kind: "code", entries }))).toBe(49152);
    entries[47] += "x";
    fails(() => validateDatasetChunkV2({ kind: "code", entries }), "quota");
  });
  it("reproduces T0 fit/reject arithmetic with all eight real datasets", () => {
    const h = chartHeader(),
      p = chartPoints();
    const make = (cell: string) => [
      ...Array.from({ length: 4 }, () => ({
        declaration: chartDeclaration,
        header: h,
        entries: p,
      })),
      {
        declaration: declaration("table", 8),
        header: { kind: "table" as const },
        entries: rows(8, cell),
      },
      ...Array.from({ length: 2 }, () => ({
        declaration: declaration("list", 3),
        header: { kind: "list" as const },
        entries: rows(3, cell),
      })),
      {
        declaration: { kind: "code" as const },
        header: { kind: "code" as const },
        entries: Array(16).fill("界".repeat(1024)),
      },
    ];
    expect(canonicalDatasetV2Bytes(h, p).byteLength).toBe(27890);
    expect(validateDatasetPanelV2(make("value"))).toEqual({ byteLength: 177807, pointCount: 6400 });
    expect(
      make("臺".repeat(200)).reduce(
        (n, d) => n + canonicalDatasetV2Bytes(d.header, d.entries).byteLength,
        0,
      ),
    ).toBe(594307);
    fails(() => validateDatasetPanelV2(make("臺".repeat(200))), "quota");
    fails(() => validateDatasetPanelV2([...make("value"), make("value")[4]!]), "quota");
  });
  it("checks exact 524287/524288/524289 panel bytes without synthetic accounting", () => {
    const tables = Array.from({ length: 2 }, () => ({
      declaration: declaration("table", 8),
      header: { kind: "table" as const },
      entries: rows(8, "臺".repeat(200)),
    }));
    const entries = Array(12).fill("臺".repeat(950));
    const base =
      tables.reduce((n, d) => n + canonicalDatasetV2Bytes(d.header, d.entries).length, 0) +
      canonicalDatasetV2Bytes({ kind: "code" }, entries).length;
    entries[0] += "x".repeat(524287 - base);
    const datasets = [
      ...tables,
      { declaration: { kind: "code" as const }, header: { kind: "code" as const }, entries },
    ];
    expect(validateDatasetPanelV2(datasets).byteLength).toBe(524287);
    entries[0] += "x";
    expect(validateDatasetPanelV2(datasets).byteLength).toBe(524288);
    entries[0] += "x";
    fails(() => validateDatasetPanelV2(datasets), "quota");
  });
  it("checks 799/800/801 per-series bounds independently of the 1600 total", () => {
    const h = chartHeader(),
      p = chartPoints();
    p.splice(799, 1);
    h.series[0]!.omittedPoints++;
    expect(validateDatasetV2(chartDeclaration, h, p).entries).toHaveLength(1599);
    p.splice(799, 0, [0, 0, 399500, 100]);
    h.series[0]!.omittedPoints--;
    expect(validateDatasetV2(chartDeclaration, h, p).entries).toHaveLength(1600);
    p.pop();
    h.series[1]!.omittedPoints++;
    p.splice(800, 0, [0, 0, 400000, 0]);
    h.series[0]!.omittedPoints--;
    fails(() => validateDatasetV2(chartDeclaration, h, p));
  });
  it("enforces canonical entry bytes even when string counts fit", () => {
    const row = { key: "r", version: null, cells: Array(8).fill("\x01".repeat(200)) };
    expect(datasetChunkV2Schema.safeParse({ kind: "table", entries: [row] }).success).toBe(true);
    fails(() => validateDatasetChunkV2({ kind: "table", entries: [row] }), "quota");
  });
});

it("keeps the shared Python binary64 formatting vectors tied to JavaScript", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL(
        "../../../test-fixtures/declarative-ui-v2/data/binary64-golden.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { cases: { bits: string; json: string }[] };
  expect(vectors.cases.length).toBeGreaterThanOrEqual(990);
  for (const entry of vectors.cases) {
    const n = Buffer.from(entry.bits, "hex").readDoubleBE();
    expect(Number.isFinite(n)).toBe(true);
    expect(JSON.stringify(n)).toBe(entry.json);
  }
});
