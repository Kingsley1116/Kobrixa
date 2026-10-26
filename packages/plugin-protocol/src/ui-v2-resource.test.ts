import { describe, expect, it } from "vitest";
import { z } from "zod";
import { uiResourceV1Schema } from "./ui-resource.js";
import { validateDatasetDeclarationV2 } from "./ui-v2-data.js";
import {
  validateUiResource,
  validateCommandValue,
  acceptsValue,
  uiBytes,
  type UiValidationContext,
} from "./ui-validation.js";
import {
  uiResourceV2Schema,
  validateUiResourceV2,
  type PanelResourceV2,
  type StatusResourceV2,
} from "./ui-v2-resource.js";
const counter = {
  type: "number" as const,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  integer: true,
  nullable: false,
};
const context: UiValidationContext = {
  pluginId: "test.lab",
  panels: [
    {
      id: "test.lab.panel",
      location: "right",
      title: { en: "Lab" },
      resource: { version: 1, path: "panel.json" },
    },
  ],
  commands: [
    {
      id: "test.lab.cursor",
      title: { en: "Cursor" },
      invocation: "context-v1",
      arguments: {
        time: { type: "number", min: 0, max: Number.MAX_VALUE, integer: false, nullable: false },
        presentation: counter,
      },
    },
    {
      id: "test.lab.select",
      title: { en: "Select" },
      invocation: "context-v1",
      arguments: {
        key: { type: "string", maxLength: 128, nullable: false },
        revision: { type: "string", maxLength: 128, nullable: true },
        dataset: counter,
      },
    },
    { id: "test.lab.copy", title: { en: "Copy" }, invocation: "context-v1", arguments: {} },
  ],
};
const cursor = {
  command: "test.lab.cursor",
  arguments: {},
  timeArg: "time",
  presentationArg: "presentation",
  readings: [{ dataset: "chart", series: "s0", rawKey: "raw", valueKey: "value" }],
};
const row = {
  command: "test.lab.select",
  arguments: {},
  rowKeyArg: "key",
  rowVersionArg: "revision",
  datasetRevisionArg: "dataset",
};
const make = (): PanelResourceV2 => ({
  kind: "panel",
  root: "root",
  data: {
    presentation: { schema: { ...counter }, initial: 0 },
    reservation: { schema: { type: "string", maxLength: 36, nullable: true }, initial: null },
  },
  fields: {},
  presentationKey: "presentation",
  datasets: {
    chart: { kind: "chart", series: [{ id: "s0", label: { en: "Sensor" } }] },
    history: { kind: "list", columns: [{ id: "name", label: { en: "Name" }, value: "string" }] },
    code: { kind: "code" },
  },
  nodes: [
    {
      id: "root",
      type: "group",
      layout: "stack",
      children: ["plot", "history", "stop", "code", "expand"],
    },
    {
      id: "plot",
      type: "lineChart",
      label: { en: "Plot" },
      dataset: "chart",
      cursorGroup: "cursor",
      timeView: "default",
      onCursor: structuredClone(cursor),
    },
    {
      id: "history",
      type: "list",
      label: { en: "History" },
      dataset: "history",
      actions: [
        {
          id: "delete",
          label: { en: "Delete" },
          action: { kind: "view", action: "openDialog", dialogId: "confirm" },
        },
      ],
    },
    {
      id: "stop",
      type: "action",
      label: { en: "Stop" },
      variant: "danger",
      action: {
        kind: "core",
        action: "stopRecording",
        reservation: { scope: "data", key: "reservation" },
      },
    },
    {
      id: "code",
      type: "code",
      label: { en: "Code" },
      dataset: "code",
      copy: { command: "test.lab.copy", arguments: {} },
    },
    {
      id: "expand",
      type: "action",
      label: { en: "Expand" },
      variant: "normal",
      action: { kind: "view", action: "openDialog", dialogId: "expanded" },
    },
    {
      id: "confirm",
      type: "dialog",
      label: { en: "Confirm" },
      children: ["cancel"],
      confirm: { label: { en: "Delete" }, command: structuredClone(row), dataset: "history" },
    },
    {
      id: "cancel",
      type: "action",
      label: { en: "Cancel" },
      variant: "normal",
      action: { kind: "view", action: "closeDialog", dialogId: "confirm" },
    },
    { id: "expanded", type: "dialog", label: { en: "Expanded" }, children: ["inspect"] },
    {
      id: "inspect",
      type: "lineChart",
      label: { en: "Inspection" },
      dataset: "chart",
      cursorGroup: "cursor",
      timeView: "inspect",
      onCursor: structuredClone(cursor),
    },
  ],
});
const check = (v: unknown, ctx = context) => validateUiResourceV2(v, ctx, 1024);
const node = (r: PanelResourceV2, id: string) => r.nodes.find((n) => n.id === id)!;
describe("unpublished UI v2 resource leaves", () => {
  it("accepts exact declarative chart/history/confirmation/expanded/Stop contract", () => {
    expect(check(make()).ok).toBe(true);
  });
  it("does not make v1 accept v2 or change negotiation", () => {
    expect(uiResourceV1Schema.safeParse(make()).success).toBe(false);
    expect(validateUiResource(make(), context, 1024, 2).ok).toBe(false);
    expect(validateUiResourceV2(make(), context, 1024, 1).ok).toBe(false);
  });
  it("keeps both strict wire schemas JSON-Schema exportable", () => {
    const schema = z.toJSONSchema(uiResourceV2Schema);
    expect(JSON.stringify(schema)).toContain("stopRecording");
    expect(schema).toBeTruthy();
  });
  it("allows only core Open and recording Stop on status", () => {
    const panel = make();
    const status = {
      kind: "status",
      text: { text: { en: "Recording" } },
      tone: "info",
      data: panel.data,
      actions: [
        {
          id: "open",
          label: { en: "Open" },
          action: { kind: "core", action: "openPanel", panelId: "test.lab.panel" },
        },
        {
          id: "stop",
          label: { en: "Stop" },
          action: {
            kind: "core",
            action: "stopRecording",
            reservation: { scope: "data", key: "reservation" },
          },
        },
      ],
    };
    expect(check(status).ok).toBe(true);
    expect(
      check({
        ...status,
        actions: [
          {
            id: "command",
            label: { en: "Run" },
            action: { kind: "command", command: "test.lab.copy", arguments: {} },
          },
        ],
      }).ok,
    ).toBe(false);
    expect(check({ ...status, actions: [...status.actions, status.actions[0]] }).ok).toBe(false);
  });
  it.each([
    [
      "presentation nullable",
      (r: PanelResourceV2) => {
        r.data.presentation!.schema.nullable = true;
      },
    ],
    [
      "presentation prepublished",
      (r: PanelResourceV2) => {
        r.data.presentation!.initial = 1;
      },
    ],
    [
      "missing reservation",
      (r: PanelResourceV2) => {
        delete r.data.reservation;
      },
    ],
    [
      "wrong dataset kind",
      (r: PanelResourceV2) => {
        r.datasets.chart = { kind: "code" };
      },
    ],
    [
      "unreachable dialog",
      (r: PanelResourceV2) => {
        const n = node(r, "expand");
        if (n.type === "action") n.action = { kind: "core", action: "openRecovery" };
      },
    ],
    [
      "dialog in initial tree",
      (r: PanelResourceV2) => {
        const n = node(r, "root");
        if (n.type === "group") n.children.push("expanded");
      },
    ],
    [
      "nested dialog",
      (r: PanelResourceV2) => {
        const n = node(r, "confirm");
        if (n.type === "dialog") n.children.push("expanded");
      },
    ],
    [
      "shared child across trees",
      (r: PanelResourceV2) => {
        const n = node(r, "expanded");
        if (n.type === "dialog") n.children.push("cancel");
      },
    ],
    [
      "inspect in ordinary tree",
      (r: PanelResourceV2) => {
        const n = node(r, "plot");
        if (n.type === "lineChart") n.timeView = "inspect";
      },
    ],
    [
      "wrong close target",
      (r: PanelResourceV2) => {
        const n = node(r, "cancel");
        if (n.type === "action")
          n.action = { kind: "view", action: "closeDialog", dialogId: "expanded" };
      },
    ],
    [
      "plain action selects row confirmation",
      (r: PanelResourceV2) => {
        const n = node(r, "expand");
        if (n.type === "action")
          n.action = { kind: "view", action: "openDialog", dialogId: "confirm" };
      },
    ],
    [
      "foreign command",
      (r: PanelResourceV2) => {
        const n = node(r, "code");
        if (n.type === "code") n.copy.command = "other.copy";
      },
    ],
    [
      "event/static argument collision",
      (r: PanelResourceV2) => {
        const n = node(r, "plot");
        if (n.type === "lineChart") n.onCursor.arguments.time = { literal: 0 };
      },
    ],
    [
      "missing cursor series",
      (r: PanelResourceV2) => {
        const n = node(r, "plot");
        if (n.type === "lineChart") n.onCursor.readings[0]!.series = "missing";
      },
    ],
    [
      "duplicate output slots",
      (r: PanelResourceV2) => {
        const n = node(r, "plot");
        if (n.type === "lineChart") n.onCursor.readings[0]!.valueKey = "raw";
      },
    ],
    [
      "different cursor group",
      (r: PanelResourceV2) => {
        const n = node(r, "inspect");
        if (n.type === "lineChart") n.cursorGroup = "second";
      },
    ],
    [
      "different cursor handlers",
      (r: PanelResourceV2) => {
        const n = node(r, "inspect");
        if (n.type === "lineChart") n.onCursor.readings[0]!.rawKey = "other";
      },
    ],
    [
      "duplicate row argument",
      (r: PanelResourceV2) => {
        const n = node(r, "confirm");
        if (n.type === "dialog" && n.confirm) n.confirm.command.rowVersionArg = "key";
      },
    ],
    [
      "duplicate dataset series",
      (r: PanelResourceV2) => {
        const d = r.datasets.chart;
        if (d?.kind === "chart") d.series.push(d.series[0]!);
      },
    ],
    [
      "unsafe label",
      (r: PanelResourceV2) => {
        const n = node(r, "history");
        if (n.type === "list") n.actions[0]!.label.en = "bad\u0000label";
      },
    ],
  ] as const)("rejects %s", (_, mutate) => {
    const r = make();
    expect(check(r).ok).toBe(true);
    mutate(r);
    expect(check(r).ok).toBe(false);
  });
  it("rejects forged keys before record parsing can erase them", () => {
    const r = JSON.parse(JSON.stringify(make()));
    r.datasets = JSON.parse('{"__proto__":{"kind":"code"}}');
    expect(check(r).ok).toBe(false);
  });
  it("checks dynamic command parameter nullability and finite-number domains", () => {
    const ctx = structuredClone(context);
    ctx.commands[1]!.arguments.revision = { type: "string", maxLength: 128, nullable: false };
    expect(check(make(), ctx).ok).toBe(false);
    const c = structuredClone(context);
    c.commands[0]!.arguments.time = { ...counter };
    expect(check(make(), c).ok).toBe(false);
  });
  it("bounds declaration counts independently of repeated chart views", () => {
    const r = make();
    // Declarations need not be displayed yet; expanded views reuse the same dataset.
    for (let i = 0; i < 5; i++)
      r.datasets[`table-${i}`] = {
        kind: "table",
        columns: [{ id: "n", label: { en: "N" }, value: "number" }],
      };
    expect(check(r).ok).toBe(true);
    r.datasets.extra = {
      kind: "list",
      columns: [{ id: "n", label: { en: "N" }, value: "number" }],
    };
    expect(check(r).ok).toBe(false);
    const charts = make();
    for (let i = 0; i < 3; i++)
      charts.datasets[`chart-${i}`] = structuredClone(charts.datasets.chart!);
    expect(check(charts).ok).toBe(true);
    charts.datasets.extra = structuredClone(charts.datasets.chart!);
    expect(check(charts).ok).toBe(false);
    const code = make();
    code.datasets.extra = { kind: "code" };
    expect(check(code).ok).toBe(false);
  });
  it("does not let events shadow static arguments or steal command ownership", () => {
    const r = make();
    const chart = node(r, "plot");
    if (chart.type === "lineChart") chart.onCursor.arguments.time = { literal: 0 };
    expect(check(r).ok).toBe(false);
    const ctx = structuredClone(context);
    ctx.commands[0]!.id = "foreign.cursor";
    const other = make();
    for (const n of other.nodes) if (n.type === "lineChart") n.onCursor.command = "foreign.cursor";
    expect(check(other, ctx).ok).toBe(false);
  });
  it("applies resource byte and version limits before admission", () => {
    const r = make();
    expect(validateUiResourceV2(r, context, Number.MAX_SAFE_INTEGER).ok).toBe(false);
    expect(validateUiResourceV2(r, context, -1).ok).toBe(false);
    expect(validateUiResourceV2(r, context, 1.5).ok).toBe(false);
    expect(validateUiResourceV2(r, context, 0, 1).ok).toBe(false);
  });
  it("retains ordinary v1 field semantics in v2", () => {
    const r = make();
    r.fields.speed = {
      schema: { type: "number", min: 0, max: 10, integer: true, nullable: false },
      initial: 3,
      required: true,
    };
    const root = node(r, "root");
    if (root.type === "group") root.children.push("speed");
    r.nodes.push({ id: "speed", type: "range", field: "speed", label: { en: "Speed" }, step: 2 });
    expect(check(r).ok).toBe(false);
    r.fields.speed.initial = 4;
    expect(check(r), JSON.stringify(check(r))).toMatchObject({ ok: true });
  });
});

const stopStatus = (panel = make()): StatusResourceV2 => ({
  kind: "status",
  text: { text: { en: "Recording" } },
  tone: "info",
  data: panel.data,
  actions: [
    {
      id: "stop",
      label: { en: "Stop" },
      action: {
        kind: "core",
        action: "stopRecording",
        reservation: { scope: "data", key: "reservation" },
      },
    },
  ],
});
const invocation = {
  version: 1 as const,
  invocationId: "00000000-0000-4000-8000-000000000001",
  command: "test.lab.cursor",
  arguments: {},
  context: {
    contextRef: null,
    origin: "management" as const,
    locale: "en" as const,
    trigger: { kind: "activate" as const },
  },
};
const reservationId = "00000000-0000-4000-8000-000000000001";
describe("reviewed resource admission regressions", () => {
  it.each([
    ["panel", 65536],
    ["status", 16384],
  ] as const)("%s keeps its v1 initial scalar byte boundary (%i)", (kind, limit) => {
    const r = kind === "panel" ? make() : stopStatus();
    const initial = () =>
      Object.fromEntries(Object.entries(r.data).map(([key, slot]) => [key, slot.initial]));
    let last = "";
    while (uiBytes(initial()) < limit) {
      last = `padding-${Object.keys(r.data).length}`;
      r.data[last] = { schema: { type: "string", maxLength: 4000, nullable: false }, initial: "" };
      r.data[last]!.initial = "x".repeat(Math.min(4000, limit - uiBytes(initial())));
    }
    expect(uiBytes(initial())).toBe(limit);
    const v1 =
      kind === "panel"
        ? {
            kind: "panel",
            root: "root",
            fields: {},
            nodes: [
              { id: "root", type: "group", layout: "stack", children: ["body"] },
              { id: "body", type: "text", value: { text: { en: "Ready" } }, emphasis: "normal" },
            ],
            data: r.data,
          }
        : { kind: "status", text: { text: { en: "Recording" } }, tone: "info", data: r.data };
    expect(validateUiResource(v1, context, uiBytes(v1)).ok).toBe(true);
    expect(validateUiResourceV2(r, context, uiBytes(r)).ok).toBe(true);
    r.data[last]!.initial += "x";
    expect(uiBytes(initial())).toBe(limit + 1);
    for (const result of [
      validateUiResource(v1, context, uiBytes(v1)),
      validateUiResourceV2(r, context, uiBytes(r)),
    ])
      expect(result).toMatchObject({
        ok: false,
        error: {
          detail: {
            reason: "limit",
            limit: kind === "panel" ? "dataBytes" : "statusDataBytes",
            allowed: limit,
          },
        },
      });
  });
  it.each(["rawKey", "valueKey"] as const)("%s uses command-result safe keys", (field) => {
    for (const key of ["constructor", "prototype", "__proto__"]) {
      const r = make();
      // Change both views so cursor-group equality cannot mask the invalid output key.
      for (const n of r.nodes) if (n.type === "lineChart") n.onCursor.readings[0]![field] = key;
      const output = Object.fromEntries([
        [key, 1],
        [field === "rawKey" ? "value" : "raw", null],
      ]);
      expect(validateCommandValue({ output, fieldErrors: [] }, invocation).ok).toBe(false);
      expect(check(r).ok, `${field}=${key}`).toBe(false);
    }
    expect(check(make()).ok).toBe(true);
    expect(
      validateCommandValue({ output: { raw: 1, value: null }, fieldErrors: [] }, invocation).ok,
    ).toBe(true);
  });
  describe.each(["panel", "status"] as const)("%s Stop reservation slot", (kind) => {
    const resource = () => (kind === "panel" ? make() : stopStatus());
    it.each([1, 35, 37])(
      "rejects maxLength %i rather than the fixed 36-character binding",
      (maxLength) => {
        const r = resource();
        r.data.reservation!.schema = { type: "string", maxLength, nullable: true };
        if (maxLength < 36)
          expect(acceptsValue(r.data.reservation!.schema, reservationId)).toBe(false);
        expect(check(r).ok).toBe(false);
      },
    );
    it.each([null, reservationId])("accepts nullable UUID initial %s", (initial) => {
      const r = resource();
      r.data.reservation!.initial = initial;
      expect(acceptsValue(r.data.reservation!.schema, reservationId)).toBe(true);
      expect(check(r).ok).toBe(true);
    });
    it.each(["", "not-a-uuid", "x".repeat(36), "00000000-0000-0000-0000-000000000000"])(
      "rejects non-UUID initial %s",
      (initial) => {
        const r = resource();
        r.data.reservation!.initial = initial;
        expect(acceptsValue(r.data.reservation!.schema, initial)).toBe(true);
        expect(check(r).ok).toBe(false);
      },
    );
    it("leaves unrelated nullable strings unchanged", () => {
      const r = resource();
      r.data.unrelated = { schema: { type: "string", maxLength: 1, nullable: true }, initial: "x" };
      expect(check(r).ok).toBe(true);
    });
  });
});

describe.each(["chart", "table", "list"] as const)("dataset %s ID admission parity", (kind) => {
  it.each(["constructor", "prototype"])("rejects unusable declaration ID %s", (forbidden) => {
    const r = make();
    if (kind === "table") {
      r.datasets.table = {
        kind: "table",
        columns: [{ id: "column-1", label: { en: "Column" }, value: "number" }],
      };
      const root = node(r, "root");
      if (root.type === "group") root.children.push("table");
      r.nodes.push({ id: "table", type: "table", dataset: "table", label: { en: "Table" } });
    }
    const declaration = r.datasets[kind === "list" ? "history" : kind]!;
    const rename = (id: string) => {
      if (declaration.kind === "chart") {
        declaration.series[0]!.id = id;
        // Both views must still resolve the renamed series and share the same cursor.
        // Otherwise reference/group rejection would hide the unsafe ID bug.
        for (const n of r.nodes) if (n.type === "lineChart") n.onCursor.readings[0]!.series = id;
      } else if (declaration.kind !== "code") declaration.columns[0]!.id = id;
    };
    rename("reading-1");
    expect(validateDatasetDeclarationV2(declaration)).toEqual(declaration);
    expect(check(r).ok).toBe(true);
    rename(forbidden);
    expect(() => validateDatasetDeclarationV2(declaration)).toThrow();
    expect(check(r)).toMatchObject({
      ok: false,
      error: { detail: { reason: "reference" } },
    });
  });
});

it("admits an explicit derived-form correlation only on synchronized panels and a separate counter", () => {
  const resource = make();
  resource.formSync = true;
  resource.derivedFormRevisionKey = "derived";
  resource.data.derived = { schema: { ...counter }, initial: 0 };
  expect(validateUiResourceV2(resource, context, uiBytes(resource)).ok).toBe(true);
  for (const change of [
    (r: PanelResourceV2) => {
      delete r.formSync;
    },
    (r: PanelResourceV2) => {
      r.derivedFormRevisionKey = r.presentationKey;
    },
    (r: PanelResourceV2) => {
      r.data.derived!.schema = { type: "string", maxLength: 20, nullable: false };
      r.data.derived!.initial = "0";
    },
  ]) {
    const copy = structuredClone(resource);
    change(copy);
    expect(validateUiResourceV2(copy, context, uiBytes(copy))).toMatchObject({
      ok: false,
      error: { detail: { fieldPath: "$.derivedFormRevisionKey" } },
    });
  }
});
