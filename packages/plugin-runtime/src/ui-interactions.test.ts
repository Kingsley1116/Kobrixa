import { expect, it, vi } from "vitest";
import { uiInteractionRequestSchema, UiInteractions } from "./ui-interactions.js";
import type { UiInteractionRequest } from "./ui-host-ports.js";
const binding = {
  kind: "panel" as const,
  contributionId: "test.lab.panel",
  panelInstance: "00000000-0000-4000-8000-000000000001",
  generation: 1,
  uiResourceGeneration: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000002",
  processEpoch: "00000000-0000-4000-8000-000000000003",
};
it("strict interaction admission never accepts caller arguments or authority", () => {
  const input: UiInteractionRequest = { kind: "core", binding, actionId: "stop" };
  expect(uiInteractionRequestSchema.safeParse(input).success).toBe(true);
  for (const key of ["arguments", "owner", "actionRef", "motionScopeRef", "form"])
    expect(uiInteractionRequestSchema.safeParse({ ...input, [key]: {} }).success).toBe(false);
});
it("unresolved bindings cannot acquire view or control authority", async () => {
  const core = vi.fn();
  const host = new UiInteractions({
    resolve: () => null,
    currentData: () => false,
    read: vi.fn(),
    snapshot: vi.fn(),
    core,
    dispatch: vi.fn(),
    admit: () => null,
    acceptForm: () => false,
    mintAction: () => {
      throw new Error("unexpected");
    },
    now: () => 0,
  });
  expect((await host.interact({ kind: "viewState", binding })).ok).toBe(false);
  expect((await host.interact({ kind: "core", binding, actionId: "stop" })).ok).toBe(false);
  expect(core).not.toHaveBeenCalled();
  host.dispose();
});
import type { UiInteractionPorts, UiInteractionResolved } from "./ui-interactions.js";
import type {
  PanelResourceV2,
  UiStateSnapshot,
  ChartHeaderV2,
  CommandValue,
  Result,
} from "@kobrixa/plugin-protocol";
const counter = {
  type: "number" as const,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  integer: true,
  nullable: false,
};
function fixture() {
  const rowCommand = {
    command: "test.lab.row",
    arguments: {},
    rowKeyArg: "key",
    rowVersionArg: "version",
    datasetRevisionArg: "revision",
  };
  const cursor = {
    command: "test.lab.cursor",
    arguments: {},
    timeArg: "time",
    presentationArg: "presentation",
    readings: [{ dataset: "chart", series: "s", rawKey: "raw", valueKey: "value" }],
  };
  const resource: PanelResourceV2 = {
    kind: "panel",
    root: "root",
    presentationKey: "presentation",
    data: {
      presentation: { schema: counter, initial: 0 },
      reservation: { schema: { type: "string", maxLength: 36, nullable: true }, initial: null },
    },
    fields: {},
    datasets: {
      rows: { kind: "list", columns: [{ id: "label", label: { en: "Label" }, value: "string" }] },
      chart: { kind: "chart", series: [{ id: "s", label: { en: "S" } }] },
      code: { kind: "code" },
    },
    nodes: [
      {
        id: "root",
        type: "group",
        layout: "stack",
        children: ["list", "code", "chart", "expand", "stop"],
      },
      {
        id: "list",
        type: "list",
        label: { en: "Rows" },
        dataset: "rows",
        actions: [
          {
            id: "choose",
            label: { en: "Choose" },
            action: { kind: "command", command: rowCommand },
          },
          {
            id: "delete",
            label: { en: "Delete" },
            action: { kind: "view", action: "openDialog", dialogId: "confirm" },
          },
        ],
      },
      {
        id: "code",
        type: "code",
        label: { en: "Code" },
        dataset: "code",
        copy: { command: "test.lab.copy", arguments: {} },
      },
      {
        id: "chart",
        type: "lineChart",
        label: { en: "Chart" },
        dataset: "chart",
        cursorGroup: "g",
        timeView: "default",
        onCursor: cursor,
      },
      {
        id: "expand",
        type: "action",
        label: { en: "Expand" },
        variant: "normal",
        action: { kind: "view", action: "openDialog", dialogId: "inspect" },
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
        id: "confirm",
        type: "dialog",
        label: { en: "Confirm" },
        children: ["help"],
        confirm: { label: { en: "Confirm" }, dataset: "rows", command: rowCommand },
      },
      { id: "help", type: "help", value: { text: { en: "Confirm this row" } } },
      { id: "inspect", type: "dialog", label: { en: "Inspect" }, children: ["chart-inspect"] },
      {
        id: "chart-inspect",
        type: "lineChart",
        label: { en: "Expanded" },
        dataset: "chart",
        cursorGroup: "g",
        timeView: "inspect",
        onCursor: cursor,
      },
    ],
  };
  const state: UiStateSnapshot = {
    binding,
    revision: 0,
    data: { presentation: 1, reservation: binding.panelInstance },
    formRevision: 0,
    form: {},
    valid: true,
    visible: true,
    locale: "en",
  };
  let current = true,
    now = 0,
    revision = 1,
    rowVersion: string | null = "v1";
  let header: ChartHeaderV2 = {
    kind: "chart",
    timeDomain: [0, 100000],
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
  };
  const owner = {
    sourceKey: "builtin:test.lab",
    pluginId: "test.lab",
    generation: 1,
    hostEpoch: binding.hostEpoch,
    processEpoch: binding.processEpoch,
  };
  const resolved: UiInteractionResolved = {
    owner,
    resource,
    state,
    workbenchInstance: "window",
    contextRef: null,
    commands: new Map([
      [
        "test.lab.row",
        {
          id: "test.lab.row",
          title: { en: "Row" },
          invocation: "context-v1",
          arguments: {
            key: { type: "string", maxLength: 128, nullable: false },
            version: { type: "string", maxLength: 128, nullable: true },
            revision: counter,
          },
        },
      ],
      [
        "test.lab.cursor",
        {
          id: "test.lab.cursor",
          title: { en: "Cursor" },
          invocation: "context-v1",
          arguments: {
            time: {
              type: "number",
              min: 0,
              max: Number.MAX_VALUE,
              integer: false,
              nullable: false,
            },
            presentation: counter,
          },
        },
      ],
      [
        "test.lab.copy",
        { id: "test.lab.copy", title: { en: "Copy" }, invocation: "context-v1", arguments: {} },
      ],
    ]),
  };
  const metadata = (dataset: string) => ({
    dataset,
    revision,
    presentation: 1,
    byteLength: 100,
    sha256: "a".repeat(64),
  });
  const dispatch = vi.fn<UiInteractionPorts["dispatch"]>(async (_r, i) => ({
    ok: true,
    value: {
      output: i.command === "test.lab.cursor" ? { raw: 1, value: null } : {},
      fieldErrors: [],
    },
  }));
  const core = vi.fn<UiInteractionPorts["core"]>(async () => ({
    ok: true,
    value: { output: {}, fieldErrors: [] },
  }));
  const mint = vi.fn(() => binding.panelInstance);
  const ports: UiInteractionPorts = {
    resolve: (b) => (current && b.panelInstance === binding.panelInstance ? resolved : null),
    now: () => now,
    admit: () => null,
    currentData: (_b, expected) =>
      current && expected.every((m) => m.revision === revision && m.presentation === 1),
    snapshot: async () => ({
      ok: true,
      value: { datasets: [metadata("rows"), metadata("chart"), metadata("code")] },
    }),
    read: async (q) => {
      const common = { ...metadata(q.dataset), nextOffset: 1, done: true };
      if (q.revision !== revision)
        return {
          ok: false,
          error: {
            code: "PLUGIN_E_STALE_RESOURCE",
            message: "stale",
            detail: { kind: "ui-data", reason: "stale" },
          },
        };
      if (q.dataset === "rows")
        return {
          ok: true,
          value: {
            ...common,
            header: { kind: "list" },
            chunk: { kind: "list", entries: [{ key: "row", version: rowVersion, cells: ["Row"] }] },
          },
        };
      if (q.dataset === "code")
        return {
          ok: true,
          value: {
            ...common,
            header: { kind: "code" },
            chunk: { kind: "code", entries: ["code"] },
          },
        };
      return { ok: true, value: { ...common, header, chunk: { kind: "chart", entries: [] } } };
    },
    dispatch,
    core,
    mintAction: mint,
    acceptForm: (_b, n, values) => {
      if (n !== state.formRevision + 1) return false;
      state.formRevision = n;
      state.form = values;
      return true;
    },
  };
  const host = new UiInteractions(ports);
  const q = (nodeId: string, command = false) => ({
    binding,
    nodeId,
    presentation: 1,
    viewGeneration: 0,
    formRevision: state.formRevision + (command ? 1 : 0),
    form: {},
  });
  return {
    host,
    ports,
    dispatch,
    core,
    mint,
    state,
    resource,
    resolved,
    q,
    header: () => header,
    setHeader: (h: ChartHeaderV2) => {
      header = h;
    },
    time: (t: number) => {
      now = t;
    },
    retire: () => {
      current = false;
    },
    replace: () => {
      revision++;
      rowVersion = "v2";
    },
  };
}
function ok<T>(r: Result<T>): T {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
it("row arguments come from the current committed tuple and not the caller", async () => {
  const h = fixture();
  const result = ok(
    await h.host.interact({
      ...h.q("list", true),
      kind: "list",
      actionId: "choose",
      dataset: "rows",
      revision: 1,
      key: "row",
    }),
  );
  expect(result.kind).toBe("command");
  expect(h.dispatch.mock.calls[0]![1].arguments).toEqual({
    key: "row",
    version: "v1",
    revision: 1,
  });
  expect(h.mint).toHaveBeenCalledOnce();
  h.host.dispose();
});
it("dialog captures a tuple, refuses replacement, and closes on hide", async () => {
  const h = fixture();
  const opened = ok(
    await h.host.interact({
      ...h.q("list"),
      kind: "list",
      actionId: "delete",
      dataset: "rows",
      revision: 1,
      key: "row",
    }),
  );
  if (opened.kind !== "view") throw new Error("view");
  expect(opened.view.dialogId).toBe("confirm");
  h.replace();
  expect(
    (
      await h.host.interact({
        ...h.q("confirm", true),
        viewGeneration: opened.view.generation,
        kind: "dialogConfirm",
      })
    ).ok,
  ).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.host.invalidate(binding);
  const view = ok(await h.host.interact({ kind: "viewState", binding }));
  expect(view).toMatchObject({ kind: "view", view: { dialogId: null } });
  h.host.dispose();
});
it("plain open cannot open a row-confirm dialog; closed dialog children are inactive", async () => {
  const h = fixture();
  const expand = h.resource.nodes.find((n) => n.id === "expand");
  if (expand?.type !== "action") throw new Error();
  expand.action = { kind: "view", action: "openDialog", dialogId: "confirm" };
  expect((await h.host.interact({ ...h.q("expand"), kind: "action" })).ok).toBe(false);
  expect(
    (
      await h.host.interact({
        ...h.q("chart-inspect"),
        kind: "cursor",
        dataset: "chart",
        revision: 1,
        time: 50000,
      })
    ).ok,
  ).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.host.dispose();
});
it("cursor enforces the actual recent window and accepts no-value empty series at end", async () => {
  const h = fixture();
  expect(
    (
      await h.host.interact({
        ...h.q("chart"),
        kind: "cursor",
        dataset: "chart",
        revision: 1,
        time: 39999,
      })
    ).ok,
  ).toBe(false);
  const result = ok(
    await h.host.interact({
      ...h.q("chart"),
      kind: "cursor",
      dataset: "chart",
      revision: 1,
      time: null,
    }),
  );
  expect(result).toMatchObject({ kind: "cursor", time: 100000, output: { raw: 1, value: null } });
  const invocation = h.dispatch.mock.calls[0]![1];
  expect(invocation.context).not.toHaveProperty("actionRef");
  expect(invocation.context).not.toHaveProperty("motionScopeRef");
  expect(h.mint).not.toHaveBeenCalled();
  expect(h.state.formRevision).toBe(0);
  h.host.dispose();
});
it("synchronized form changes fence an already dispatched cursor result", async () => {
  const h = fixture();
  h.resource.formSync = true;
  let finish!: (result: Result<CommandValue>) => void;
  h.dispatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = h.host.interact({
    ...h.q("chart"),
    kind: "cursor",
    dataset: "chart",
    revision: 1,
    time: 50000,
  });
  await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledOnce());
  h.state.formRevision++;
  finish({ ok: true, value: { output: { raw: 1, value: 1 }, fieldErrors: [] } });
  expect((await pending).ok).toBe(false);
  h.host.dispose();
});
it.each(["before-snapshot", "before-read", "after-snapshot", "after-read"] as const)(
  "fences synchronized cursor form changes during %s using cloned host snapshots",
  async (phase) => {
    const h = fixture();
    h.resource.formSync = true;
    h.resource.fields.a = {
      schema: { type: "boolean", nullable: false },
      initial: false,
      required: false,
    };
    h.resource.nodes.push({ id: "input", type: "boolean", field: "a", label: { en: "A" } });
    const root = h.resource.nodes.find((n) => n.id === h.resource.root);
    if (root?.type === "group") root.children.push("input");
    h.state.form = { a: false };
    h.ports.resolve = () => ({ ...h.resolved, state: structuredClone(h.state) });
    let dispatched = false,
      changed = false,
      snapshots = 0;
    h.dispatch.mockImplementation(async () => {
      dispatched = true;
      return { ok: true, value: { output: { raw: 1, value: 1 }, fieldErrors: [] } };
    });
    const change = async (operation: "snapshot" | "read") => {
      // Skip interact()'s initial refresh: target the queued cursor's own
      // pre-dispatch refresh, or its final refresh after dispatch resolves.
      if (!dispatched && snapshots < 2) return;
      if (!changed && phase === `${dispatched ? "after" : "before"}-${operation}`) {
        await Promise.resolve();
        changed = true;
        h.state.formRevision++;
        h.state.form = { a: true };
      }
    };
    const snapshot = h.ports.snapshot,
      read = h.ports.read;
    h.ports.snapshot = async (q) => {
      snapshots++;
      const value = await snapshot(q);
      await change("snapshot");
      return value;
    };
    h.ports.read = async (q) => {
      const value = await read(q);
      await change("read");
      return value;
    };
    const result = await h.host.interact({
      ...h.q("chart"),
      form: { a: false },
      kind: "cursor",
      dataset: "chart",
      revision: 1,
      time: 50000,
    });
    h.host.dispose();
    expect(changed).toBe(true);
    expect(result.ok).toBe(false);
    expect(h.dispatch).toHaveBeenCalledTimes(phase.startsWith("before") ? 0 : 1);
    expect(h.mint).not.toHaveBeenCalled();
  },
);
it("inspect view changes fence late cursor replies and reopen takes the latest header default", async () => {
  const h = fixture();
  let resolve!: (r: Result<CommandValue>) => void;
  const opened = ok(await h.host.interact({ ...h.q("expand"), kind: "action" }));
  if (opened.kind !== "view") throw new Error();
  h.dispatch.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = h.host.interact({
    ...h.q("chart-inspect"),
    viewGeneration: opened.view.generation,
    kind: "cursor",
    dataset: "chart",
    revision: 1,
    time: 50000,
  });
  await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledOnce());
  const changed = ok(
    await h.host.interact({
      ...h.q("chart-inspect"),
      viewGeneration: opened.view.generation,
      kind: "chartView",
      view: "full",
    }),
  );
  expect(changed).toMatchObject({ kind: "view", view: { inspectView: "full" } });
  resolve({ ok: true, value: { output: { raw: 1, value: 1 }, fieldErrors: [] } });
  expect((await pending).ok).toBe(false);
  if (changed.kind !== "view") throw new Error();
  const closed = ok(
    await h.host.interact({
      ...h.q("inspect"),
      viewGeneration: changed.view.generation,
      kind: "dialogClose",
    }),
  );
  if (closed.kind !== "view") throw new Error();
  const reopened = ok(
    await h.host.interact({
      ...h.q("expand"),
      viewGeneration: closed.view.generation,
      kind: "action",
    }),
  );
  expect(reopened).toMatchObject({ kind: "view", view: { inspectView: "recent60s" } });
  h.host.dispose();
});
it.each([Infinity, "bad", true])(
  "cursor rejects non finite/non numeric raw output %s",
  async (bad) => {
    const h = fixture();
    h.dispatch.mockResolvedValueOnce({
      ok: true,
      value: { output: { raw: bad, value: null }, fieldErrors: [] },
    });
    expect(
      (
        await h.host.interact({
          ...h.q("chart"),
          kind: "cursor",
          dataset: "chart",
          revision: 1,
          time: null,
        })
      ).ok,
    ).toBe(false);
    h.host.dispose();
  },
);
it("domain changes refresh view generation even without points", async () => {
  const h = fixture();
  ok(await h.host.interact({ kind: "viewState", binding }));
  h.setHeader({ ...h.header(), timeDomain: [0, 200000] });
  const view = ok(await h.host.interact({ kind: "viewState", binding }));
  expect(view).toMatchObject({ kind: "view", view: { generation: 1 } });
  expect(
    (
      await h.host.interact({
        ...h.q("chart"),
        kind: "cursor",
        dataset: "chart",
        revision: 1,
        time: 100000,
      })
    ).ok,
  ).toBe(false);
  h.host.dispose();
});
it("code copy mints only for a current real dispatch and stale late replies are discarded", async () => {
  const h = fixture();
  let resolve!: (r: Result<CommandValue>) => void;
  h.dispatch.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = h.host.interact({
    ...h.q("code", true),
    kind: "codeCopy",
    dataset: "code",
    revision: 1,
  });
  await vi.waitFor(() => expect(h.dispatch).toHaveBeenCalledOnce());
  expect(h.mint).toHaveBeenCalledOnce();
  h.retire();
  resolve({ ok: true, value: { output: {}, fieldErrors: [] } });
  expect((await pending).ok).toBe(false);
  h.host.dispose();
});
it("registered Stop bypasses visibility, form and command admission without inventing invocation", async () => {
  const h = fixture();
  h.state.visible = false;
  h.state.valid = false;
  h.ports.admit = () => ({
    ok: false,
    error: { code: "PLUGIN_E_RESOURCE_LIMIT", message: "busy" },
  });
  expect(ok(await h.host.interact({ kind: "core", binding, actionId: "stop" }))).toEqual({
    kind: "control",
    accepted: true,
  });
  expect(h.core).toHaveBeenCalledOnce();
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.mint).not.toHaveBeenCalled();
  h.host.dispose();
});
it("cursor coalesces the last waiting position, keeps one in-flight, and enforces 100ms spacing", async () => {
  vi.useFakeTimers();
  const h = fixture();
  let finish!: (r: Result<CommandValue>) => void;
  try {
    h.dispatch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const first = h.host.interact({
      ...h.q("chart"),
      kind: "cursor",
      dataset: "chart",
      revision: 1,
      time: 50000,
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const second = h.host.interact({
      ...h.q("chart"),
      kind: "cursor",
      dataset: "chart",
      revision: 1,
      time: 60000,
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const last = h.host.interact({
      ...h.q("chart"),
      kind: "cursor",
      dataset: "chart",
      revision: 1,
      time: 70000,
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((await second).ok).toBe(false);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    finish({ ok: true, value: { output: { raw: 1, value: 2 }, fieldErrors: [] } });
    expect((await first).ok).toBe(false);
    h.time(99);
    await vi.advanceTimersByTimeAsync(99);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    h.time(100);
    await vi.advanceTimersByTimeAsync(1);
    expect(ok(await last)).toMatchObject({ kind: "cursor", time: 70000 });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  } finally {
    h.host.dispose();
    vi.useRealTimers();
  }
});
it("dataset replacement during a read rejects the action before dispatch", async () => {
  const h = fixture();
  const read = h.ports.read;
  h.ports.read = async (q) => {
    const result = await read(q);
    if (q.dataset === "rows") h.replace();
    return result;
  };
  expect(
    (
      await h.host.interact({
        ...h.q("list", true),
        kind: "list",
        actionId: "choose",
        dataset: "rows",
        revision: 1,
        key: "row",
      })
    ).ok,
  ).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.host.dispose();
});
it("mixed group header domains block cursor without guessing an intersection", async () => {
  const h = fixture();
  h.resource.datasets.second = { kind: "chart", series: [{ id: "s", label: { en: "S" } }] };
  const original = h.resource.nodes.find((n) => n.id === "chart");
  if (original?.type !== "lineChart") throw new Error();
  h.resource.nodes.push({ ...original, id: "second", dataset: "second" });
  const snapshot = h.ports.snapshot;
  h.ports.snapshot = async (q) => {
    const result = await snapshot(q);
    if (result.ok) result.value.datasets.push({ ...result.value.datasets[1]!, dataset: "second" });
    return result;
  };
  const read = h.ports.read;
  h.ports.read = async (q) => {
    const result = await read(q);
    if (q.dataset === "second" && result.ok && result.value.header.kind === "chart")
      return {
        ok: true,
        value: { ...result.value, header: { ...result.value.header, timeDomain: [0, 200000] } },
      };
    return result;
  };
  expect(
    (
      await h.host.interact({
        ...h.q("chart"),
        kind: "cursor",
        dataset: "chart",
        revision: 1,
        time: 50000,
      })
    ).ok,
  ).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.host.dispose();
});
it("status control uses only declared actions and no synthetic panel command", async () => {
  const h = fixture();
  h.resolved.resource = {
    kind: "status",
    text: { text: { en: "Recording" } },
    tone: "neutral",
    data: {
      reservation: { schema: { type: "string", maxLength: 36, nullable: true }, initial: null },
    },
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
  };
  h.state.binding = { ...binding, kind: "status" };
  expect(
    ok(await h.host.interact({ kind: "core", binding: h.state.binding, actionId: "stop" })),
  ).toMatchObject({ kind: "control" });
  expect(
    (await h.host.interact({ kind: "core", binding: h.state.binding, actionId: "forged" })).ok,
  ).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.host.dispose();
});

it("Stop has an independent slot while same-binding Open is deferred", async () => {
  const h = fixture();
  const open = {
    id: "open",
    label: { en: "Open" },
    action: { kind: "core" as const, action: "openPanel" as const, panelId: "test.lab.panel" },
  };
  h.resolved.resource = {
    kind: "status",
    text: { text: { en: "Recording" } },
    tone: "neutral",
    data: {
      reservation: { schema: { type: "string", maxLength: 36, nullable: true }, initial: null },
    },
    actions: [
      open,
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
  h.state.binding = { ...binding, kind: "status" };
  let finish!: (r: Result<CommandValue>) => void;
  h.core.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = h.host.interact({ kind: "core", binding: h.state.binding, actionId: "open" });
  await vi.waitFor(() => expect(h.core).toHaveBeenCalledOnce());
  expect(
    (await h.host.interact({ kind: "core", binding: h.state.binding, actionId: "open" })).ok,
  ).toBe(false);
  expect(
    ok(await h.host.interact({ kind: "core", binding: h.state.binding, actionId: "stop" })),
  ).toEqual({ kind: "control", accepted: true });
  expect(h.core).toHaveBeenCalledTimes(2);
  finish({ ok: true, value: { output: {}, fieldErrors: [] } });
  expect((await pending).ok).toBe(true);
  h.host.dispose();
});
it("dialog close ignores invalid/stale form but still fences the original binding and view", async () => {
  const h = fixture();
  const opened = ok(await h.host.interact({ ...h.q("expand"), kind: "action" }));
  if (opened.kind !== "view") throw new Error();
  h.resource.fields.required = {
    schema: { type: "string", maxLength: 32, nullable: true },
    initial: null,
    required: true,
  };
  h.state.form = { required: null };
  h.state.formRevision = 3;
  h.state.valid = false;
  const request = {
    ...h.q("inspect"),
    form: {},
    formRevision: 0,
    viewGeneration: opened.view.generation,
    kind: "dialogClose" as const,
  };
  expect((await h.host.interact({ ...request, viewGeneration: 0 })).ok).toBe(false);
  expect(
    (
      await h.host.interact({
        ...request,
        binding: { ...binding, processEpoch: binding.panelInstance },
      })
    ).ok,
  ).toBe(false);
  expect(ok(await h.host.interact(request))).toMatchObject({
    kind: "view",
    view: { dialogId: null },
  });
  expect(h.state.formRevision).toBe(3);
  expect(h.dispatch).not.toHaveBeenCalled();
  h.host.dispose();
});

it("a scalar state change during row lookup cannot dispatch with the earlier presentation", async () => {
  const h = fixture();
  const read = h.ports.read;
  h.ports.read = async (q) => {
    const result = await read(q);
    if (q.dataset === "rows") {
      h.state.revision++;
      h.state.data.presentation = 2;
    }
    return result;
  };
  expect(
    (
      await h.host.interact({
        ...h.q("list", true),
        kind: "list",
        actionId: "choose",
        dataset: "rows",
        revision: 1,
        key: "row",
      })
    ).ok,
  ).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.mint).not.toHaveBeenCalled();
  h.host.dispose();
});

it("advanced command arguments keep the existing 16 KiB UTF-8 limit before mint/dispatch", async () => {
  const h = fixture();
  const node = h.resource.nodes.find((n) => n.id === "code");
  if (node?.type !== "code") throw new Error("code");
  const argumentsSpec: Record<string, { type: "string"; maxLength: number; nullable: false }> = {};
  for (const key of ["a", "b", "c", "d"]) {
    node.copy.arguments[key] = { literal: "界".repeat(2000) };
    argumentsSpec[key] = { type: "string", maxLength: 4000, nullable: false };
  }
  h.resolved.commands = new Map([
    [
      "test.lab.copy",
      {
        id: "test.lab.copy",
        title: { en: "Copy" },
        invocation: "context-v1",
        arguments: argumentsSpec,
      },
    ],
  ]);
  expect(
    (
      await h.host.interact({
        ...h.q("code", true),
        kind: "codeCopy",
        dataset: "code",
        revision: 1,
      })
    ).ok,
  ).toBe(false);
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.mint).not.toHaveBeenCalled();
  expect(h.state.formRevision).toBe(0);
  h.host.dispose();
});
