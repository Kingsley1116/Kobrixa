// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ChartHeaderV2, DatasetDeclarationV2, DatasetPointV2 } from "@kobrixa/plugin-protocol";
import { datasetChartPaths, DatasetChart, DatasetTable, DatasetCode } from "./dataset-views.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => document.body.replaceChildren());
const header: ChartHeaderV2 = {
  kind: "chart",
  timeDomain: [0, 120000],
  view: "full",
  series: [
    {
      id: "s",
      unit: "deg",
      range: [-10, 10],
      extrema: [
        [0, -10],
        [1000, 10],
      ],
      fullPointCount: 3,
      omittedPoints: 0,
      omittedRuns: 0,
    },
  ],
};
const declaration: Extract<DatasetDeclarationV2, { kind: "chart" }> = {
  kind: "chart",
  series: [{ id: "s", label: { en: "Angle", "zh-TW": "角度" } }],
};
const points: DatasetPointV2[] = [
  [0, 0, 0, -10],
  [0, 0, 1000, 10],
  [0, 1, 2000, 0],
];
it("preserves run gaps and declared empty time tails instead of fitting valid points", () => {
  const paths = datasetChartPaths(header, points);
  expect(paths[0]?.match(/M/g)).toHaveLength(2);
  expect(paths[0]?.match(/L/g)).toHaveLength(1);
  expect(paths[0]).toContain("M44.00,172.00 L48.57,16.00");
  const markup = renderToStaticMarkup(
    createElement(DatasetChart, {
      label: "Angle",
      declaration,
      header,
      points,
      locale: "en",
      cursor: null,
      enabled: true,
      onCursor() {},
    }),
  );
  expect(markup).toContain("120.0 s");
  expect(markup).toContain('max="120000"');
  expect(markup).toContain("clipPath");
  expect(markup).toContain("solid");
});
it("handles finite extreme and constant value ranges without NaN or Infinity geometry", () => {
  const huge: ChartHeaderV2 = {
    ...header,
    series: [
      {
        ...header.series[0]!,
        range: [-1e308, 1e308],
        extrema: [
          [0, -1e308],
          [1, 1e308],
        ],
      },
    ],
  };
  expect(
    datasetChartPaths(huge, [
      [0, 0, 0, -1e308],
      [0, 0, 1, 1e308],
    ])[0],
  ).not.toMatch(/NaN|Infinity/);
  const constant: ChartHeaderV2 = {
    ...header,
    series: [
      {
        ...header.series[0]!,
        range: [4, 4],
        extrema: [
          [0, 4],
          [0, 4],
        ],
      },
    ],
  };
  expect(datasetChartPaths(constant, [[0, 0, 0, 4]])[0]).toContain(",94.00");
});
it("keeps empty domains, recent-window bounds and disables cursor for an incoherent group", () => {
  const empty: ChartHeaderV2 = {
    ...header,
    series: [{ ...header.series[0]!, extrema: null, fullPointCount: 0 }],
    view: "recent60s",
  };
  const markup = renderToStaticMarkup(
    createElement(DatasetChart, {
      label: "角度",
      declaration,
      header: empty,
      points: [],
      locale: "zh-TW",
      cursor: 0,
      enabled: false,
      onCursor() {},
    }),
  );
  document.body.innerHTML = markup;
  expect(document.body.textContent).toContain("沒有有效讀值");
  const slider = document.querySelector("input")!;
  expect(slider.min).toBe("60000");
  expect(slider.max).toBe("120000");
  expect(slider.value).toBe("60000");
  expect(slider.disabled).toBe(true);
});
it("dispatches the current row identity only on user selection and renders cell text literally", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onSelect = vi.fn();
  const row = { key: "row-1", version: "v1", cells: ["<img src=x onerror=alert(1)>"] };
  const props = {
    label: "History",
    declaration: {
      kind: "table" as const,
      columns: [{ id: "name", label: { en: "Name" }, value: "string" as const }],
    },
    rows: [row],
    locale: "en" as const,
    revision: 4,
    enabled: true,
    onSelect,
  };
  try {
    await act(async () => root.render(createElement(DatasetTable, props)));
    expect(onSelect).not.toHaveBeenCalled();
    expect(node.querySelector("img")).toBeNull();
    await act(async () => node.querySelector("button")!.click());
    expect(onSelect).toHaveBeenLastCalledWith({ key: "row-1", version: "v1", revision: 4 });
    await act(async () =>
      root.render(
        createElement(DatasetTable, { ...props, revision: 5, rows: [{ ...row, version: "v2" }] }),
      ),
    );
    await act(async () => node.querySelector("button")!.click());
    expect(onSelect).toHaveBeenLastCalledWith({ key: "row-1", version: "v2", revision: 5 });
    await act(async () => root.render(createElement(DatasetTable, { ...props, enabled: false })));
    await act(async () => node.querySelector("button")!.click());
    expect(onSelect).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
it("copy stays an explicit user action and code is never interpreted as HTML", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onCopy = vi.fn();
  const props = {
    label: "Code",
    entries: ["<script>", "alert(1)</script>"],
    locale: "en" as const,
    enabled: true,
    onCopy,
  };
  try {
    await act(async () => root.render(createElement(DatasetCode, props)));
    expect(onCopy).not.toHaveBeenCalled();
    expect(node.querySelector("script")).toBeNull();
    expect(node.querySelector("code")?.textContent).toBe(props.entries.join(""));
    await act(async () => node.querySelector("button")!.click());
    expect(onCopy).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
