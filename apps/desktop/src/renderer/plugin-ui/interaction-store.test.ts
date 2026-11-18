// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PanelTree } from "./components.js";
import { UiIntentController } from "./intent-controller.js";
import { afterEach, expect, it, vi } from "vitest";
import type { PanelResourceV2 } from "@kobrixa/plugin-protocol";
import type {
  PluginUiBridge,
  UiInteractionRequest,
  UiInteractionValue,
} from "@kobrixa/plugin-runtime";
import { UiInteractionStore } from "./interaction-store.js";
import { UiStateStore } from "./state-store.js";
import { UiDatasetStore } from "./data-store.js";
import { binding, deferred, fixture, snapshot, labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});
function setup(synchronized = false, derived = false) {
  const f = fixture();
  const panel: PanelResourceV2 = {
    kind: "panel",
    ...(synchronized ? { formSync: true as const } : {}),
    ...(derived ? { derivedFormRevisionKey: "computedForm" } : {}),
    root: "root",
    fields: synchronized
      ? {
          draft: {
            schema: { type: "string", nullable: false, maxLength: 4000 },
            initial: "",
            required: false,
          },
        }
      : {},
    data: {
      ...(derived
        ? {
            computedForm: {
              schema: {
                type: "number" as const,
                min: 0,
                max: Number.MAX_SAFE_INTEGER,
                integer: true,
                nullable: false as const,
              },
              initial: 0,
            },
          }
        : {}),
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
    datasets: {
      plot: { kind: "chart", series: [{ id: "raw", label: { en: "Raw" } }] },
      code: { kind: "code" },
    },
    nodes: [
      {
        id: "apply",
        type: "action",
        variant: "normal",
        label: { en: "Apply" },
        action: { kind: "command", command: "acme.ui.apply", arguments: {} },
      },
      { id: "root", type: "group", layout: "stack", children: ["chart", "code", "apply"] },
      {
        id: "code",
        type: "code",
        label: { en: "Code" },
        dataset: "code",
        copy: { command: "acme.ui.copy", arguments: {} },
      },
      {
        id: "inspect",
        type: "dialog",
        label: { en: "Inspect" },
        children: ["hint", "close-inspect"],
      },
      {
        id: "close-inspect",
        type: "action",
        variant: "normal",
        label: { en: "Close inspection" },
        action: { kind: "view", action: "closeDialog", dialogId: "inspect" },
      },
      { id: "hint", type: "help", value: { text: { en: "Inspect" } } },
      {
        id: "chart",
        type: "lineChart",
        label: { en: "Chart" },
        dataset: "plot",
        cursorGroup: "g",
        timeView: "default",
        onCursor: {
          command: "acme.ui.cursor",
          arguments: {},
          timeArg: "time",
          presentationArg: "presentation",
          readings: [{ dataset: "plot", series: "raw", rawKey: "raw", valueKey: "value" }],
        },
      },
    ],
  };
  const initial = {
    ...snapshot(),
    form: synchronized ? { draft: "" } : {},
    visible: true,
    data: { presentation: 1, ...(derived ? { computedForm: 0 } : {}) },
  };
  f.bridge.snapshot.mockResolvedValue({ ok: true, value: structuredClone(initial) });
  const syncForm = vi.fn<NonNullable<PluginUiBridge["syncForm"]>>(async (q) => {
    initial.formRevision = q.baseFormRevision + 1;
    initial.form = { ...q.form };
    return {
      ok: true,
      value: {
        formRevision: initial.formRevision,
        editSequence: q.editSequence,
        form: { ...q.form },
      },
    };
  });
  const state = new UiStateStore({ ...f.bridge, syncForm }, panel, initial);
  const data = new UiDatasetStore(binding, panel.datasets, {
    snapshot: async () => ({ ok: true, value: { datasets: [] } }),
    read: async () => {
      throw new Error("not read by interaction controller");
    },
  });
  data.setPresentation(1);
  vi.spyOn(data, "revision").mockReturnValue(1);
  let generation = 1;
  const interact = vi.fn<NonNullable<PluginUiBridge["interact"]>>(async (request) => {
    if (request.kind === "viewState")
      return {
        ok: true,
        value: { kind: "view", view: { generation, dialogId: null, inspectView: null } },
      };
    return { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "stale" } };
  });
  const store = new UiInteractionStore({ interact }, state, data, panel);
  const cursor = (time: number | null) => store.cursor("chart", "plot", time);
  const calls = () =>
    interact.mock.calls
      .map(([r]) => r)
      .filter((r): r is Extract<UiInteractionRequest, { kind: "cursor" }> => r.kind === "cursor");
  return {
    ...f,
    store,
    state,
    data,
    interact,
    cursor,
    calls,
    syncForm,
    nextGeneration: () => generation++,
  };
}
const reply = (
  request: Extract<UiInteractionRequest, { kind: "cursor" }>,
  value: number,
): { ok: true; value: UiInteractionValue } => ({
  ok: true,
  value: {
    kind: "cursor",
    invocationId: "00000000-0000-4000-8000-000000000010",
    presentation: request.presentation,
    viewGeneration: request.viewGeneration,
    time: request.time ?? 1000,
    output: { raw: value, value },
  },
});
it("coalesces cursor work to the latest request and discards an older in-flight result", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.store.refresh();
  const pending = deferred<Awaited<ReturnType<NonNullable<PluginUiBridge["interact"]>>>>();
  f.interact.mockImplementationOnce(() => pending.promise);
  f.cursor(100);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.calls()).toHaveLength(1);
  f.cursor(200);
  f.cursor(300);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.calls()).toHaveLength(1);
  pending.resolve(reply(f.calls()[0]!, 100));
  f.interact.mockImplementationOnce(async (request) => {
    if (request.kind !== "cursor") throw new Error("cursor");
    return reply(request, 300);
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls()).toHaveLength(2);
  expect(f.calls()[1]!.time).toBe(300);
  expect(f.store.getSnapshot().readings).toEqual({ raw: 300, value: 300 });
  expect(f.state.getSnapshot().busy).toBe(false);
  expect(f.bridge.invoke).not.toHaveBeenCalled();
  f.store.dispose();
  f.state.retire();
  f.data.retire();
});
it("limits burst starts to 100ms and never turns cursor requests into action authority", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.store.refresh();
  f.interact.mockImplementation(async (request) =>
    request.kind === "cursor"
      ? reply(request, 1)
      : {
          ok: true,
          value: { kind: "view", view: { generation: 1, dialogId: null, inspectView: null } },
        },
  );
  f.cursor(null);
  await vi.advanceTimersByTimeAsync(0);
  for (let n = 0; n < 20; n++) f.cursor(n);
  await vi.advanceTimersByTimeAsync(99);
  expect(f.calls()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls()).toHaveLength(2);
  expect(f.calls()[1]!.time).toBe(19);
  expect(f.calls()[0]).not.toHaveProperty("actionRef");
  expect(f.calls()[0]).not.toHaveProperty("motionScopeRef");
  expect(f.calls()[0]!.formRevision).toBe(f.state.getSnapshot().snapshot.formRevision);
  f.store.dispose();
  f.state.retire();
  f.data.retire();
});
it.each(["hide", "retire", "presentation"] as const)(
  "ignores a pending cursor after %s",
  async (change) => {
    vi.useFakeTimers();
    const f = setup();
    await f.store.refresh();
    const pending = deferred<Awaited<ReturnType<NonNullable<PluginUiBridge["interact"]>>>>();
    f.interact.mockImplementationOnce(() => pending.promise);
    f.cursor(200);
    await vi.advanceTimersByTimeAsync(0);
    const request = f.calls()[0]!;
    if (change === "hide") f.state.setVisible(false);
    else if (change === "retire") f.state.retire();
    else {
      f.nextGeneration();
      f.data.setPresentation(2);
    }
    pending.resolve(reply(request, 999));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.getSnapshot().readings).toBeNull();
    f.store.dispose();
    f.state.retire();
    f.data.retire();
  },
);
it("does not accept non-finite cursor output", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.store.refresh();
  f.interact.mockImplementationOnce(async (request) => {
    if (request.kind !== "cursor") throw new Error("cursor");
    return reply(request, Infinity);
  });
  f.cursor(100);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.getSnapshot().readings).toBeNull();
  f.store.dispose();
  f.state.retire();
  f.data.retire();
});
it.each(["reply", "rejection"] as const)(
  "closing a dialog bypasses a pending command and suppresses its late %s",
  async (outcome) => {
    const f = setup();
    await f.store.refresh();
    const pending = deferred<Awaited<ReturnType<NonNullable<PluginUiBridge["interact"]>>>>();
    let reject!: (reason: Error) => void;
    const rejected = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const accepted = vi.fn();
    f.state.onAccepted = accepted;
    f.interact.mockImplementation(async (request) => {
      if (request.kind === "viewState")
        return {
          ok: true,
          value: {
            kind: "view",
            view: { generation: 1, dialogId: "inspect", inspectView: "full" },
          },
        };
      if (request.kind === "codeCopy") return outcome === "rejection" ? rejected : pending.promise;
      if (request.kind === "dialogClose")
        return {
          ok: true,
          value: { kind: "view", view: { generation: 2, dialogId: null, inspectView: null } },
        };
      throw new Error("Unexpected interaction");
    });
    const command = f.store.act({ kind: "codeCopy", nodeId: "code", dataset: "code", revision: 1 });
    await vi.waitFor(() =>
      expect(f.interact.mock.calls.some(([request]) => request.kind === "codeCopy")).toBe(true),
    );
    await f.store.act({ kind: "dialogClose", nodeId: "inspect" });
    expect(f.store.getSnapshot().view?.dialogId).toBeNull();
    expect(f.interact.mock.calls.some(([request]) => request.kind === "dialogClose")).toBe(true);
    if (outcome === "rejection") reject(new Error("late command failure"));
    else
      pending.resolve({
        ok: true,
        value: {
          kind: "command",
          invocationId: binding.panelInstance,
          presentation: 1,
          viewGeneration: 1,
          value: { output: {}, fieldErrors: [] },
        },
      });
    await command;
    expect(accepted).not.toHaveBeenCalled();
    expect(f.store.getSnapshot().problem).toBeNull();
    f.store.dispose();
    f.state.retire();
    f.data.retire();
  },
);

it("keeps the actual dialog and its focused control mounted while data refresh is pending", async () => {
  const f = setup();
  const hostView = { generation: 2, dialogId: "inspect", inspectView: "full" as const };
  f.interact.mockResolvedValue({ ok: true, value: { kind: "view", view: hostView } });
  await f.store.refresh();
  const intent = new UiIntentController(f.bridge, f.state);
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  try {
    await act(async () =>
      root.render(
        createElement(PanelTree, {
          state: f.state,
          intent,
          locale: "en",
          labels,
          datasets: f.data,
          interactions: f.store,
        }),
      ),
    );
    const dialog = div.querySelector("dialog")!;
    const focused = dialog.querySelectorAll("button")[1]!;
    focused.focus();
    const pending = deferred<Awaited<ReturnType<NonNullable<PluginUiBridge["interact"]>>>>();
    f.interact.mockImplementationOnce(() => pending.promise);
    await act(async () => {
      f.data.setPresentation(2);
    });
    expect(div.querySelector("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(focused);
    await act(async () =>
      pending.resolve({ ok: true, value: { kind: "view", view: { ...hostView, generation: 3 } } }),
    );
    expect(div.querySelector("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(focused);
  } finally {
    await act(async () => root.unmount());
    intent.dispose();
    f.store.dispose();
    f.state.retire();
    f.data.retire();
  }
});
it("ignores a cursor rejection after a newer position is queued", async () => {
  vi.useFakeTimers();
  const f = setup();
  await f.store.refresh();
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  f.interact.mockImplementationOnce(() => pending);
  f.cursor(100);
  await vi.advanceTimersByTimeAsync(0);
  f.cursor(200);
  reject(new Error("obsolete"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.getSnapshot().problem).toBeNull();
  f.store.dispose();
  f.state.retire();
  f.data.retire();
});

it("unsent synchronized typing clears cursor readings and fences its late reply", async () => {
  vi.useFakeTimers();
  const f = setup(true);
  await f.store.refresh();
  f.interact.mockImplementationOnce(async (q) => {
    if (q.kind !== "cursor") throw Error("cursor");
    return reply(q, 10);
  });
  f.cursor(10);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.store.getSnapshot().readings).toEqual({ raw: 10, value: 10 });
  const pending = deferred<Awaited<ReturnType<NonNullable<PluginUiBridge["interact"]>>>>();
  f.interact.mockImplementationOnce(() => pending.promise);
  f.cursor(20);
  await vi.advanceTimersByTimeAsync(100);
  const request = f.calls().at(-1)!;
  f.state.edit("draft", "unsent");
  expect(f.syncForm).not.toHaveBeenCalled();
  expect(f.store.getSnapshot().readings).toBeNull();
  pending.resolve(reply(request, 20));
  await Promise.resolve();
  await Promise.resolve();
  expect(f.store.getSnapshot().readings).toBeNull();
  f.store.dispose();
  f.state.retire();
  f.data.retire();
});
it("interaction commands flush a synchronized full form before next revision submission", async () => {
  vi.useFakeTimers();
  const f = setup(true);
  await f.store.refresh();
  f.state.edit("draft", "fresh");
  const work = f.store.act({ kind: "codeCopy", nodeId: "code", dataset: "code", revision: 1 });
  await vi.advanceTimersByTimeAsync(0);
  await work;
  const call = f.interact.mock.calls.find(([q]) => q.kind === "codeCopy")?.[0];
  expect(call).toMatchObject({ formRevision: 2, form: { draft: "fresh" } });
  expect(f.syncForm).toHaveBeenCalledOnce();
  f.store.dispose();
  f.state.retire();
  f.data.retire();
});

it("disables command controls and fences cursors until a synchronized draft has matching computed data", async () => {
  vi.useFakeTimers();
  const f = setup(true, true);
  await f.store.refresh();
  const intent = new UiIntentController(f.bridge, f.state);
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  try {
    await act(async () =>
      root.render(
        createElement(PanelTree, {
          state: f.state,
          intent,
          locale: "en",
          labels,
          datasets: f.data,
          interactions: f.store,
        }),
      ),
    );
    expect(div.querySelector<HTMLButtonElement>('[data-ui-node="apply"] button')!.disabled).toBe(
      false,
    );
    await act(async () => {
      f.state.edit("draft", "changed");
      const flush = f.state.flushForm();
      await vi.advanceTimersByTimeAsync(0);
      await flush;
    });
    expect(f.state.formCurrent()).toBe(true);
    expect(f.state.derivedCurrent()).toBe(false);
    expect(div.querySelector<HTMLButtonElement>('[data-ui-node="apply"] button')!.disabled).toBe(
      true,
    );
    const before = f.calls().length;
    f.cursor(20);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls()).toHaveLength(before);
    const current = f.state.getSnapshot().snapshot;
    f.bridge.snapshot.mockResolvedValue({
      ok: true,
      value: {
        ...current,
        revision: current.revision + 1,
        data: { ...current.data, computedForm: current.formRevision },
      },
    });
    await act(async () => {
      await f.state.invalidate(current.revision + 1);
    });
    expect(f.state.derivedCurrent()).toBe(true);
    expect(div.querySelector<HTMLButtonElement>('[data-ui-node="apply"] button')!.disabled).toBe(
      false,
    );
    f.cursor(30);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls().length).toBeGreaterThan(before);
  } finally {
    await act(async () => root.unmount());
    intent.dispose();
    f.store.dispose();
    f.state.retire();
    f.data.retire();
  }
});

it.each(["derived", "unsent"] as const)(
  "keeps dialog Close available while %s form work is pending",
  async (phase) => {
    const f = setup(true, true);
    f.interact.mockImplementation(async (request) => ({
      ok: true,
      value: {
        kind: "view",
        view:
          request.kind === "viewState"
            ? { generation: 1, dialogId: "inspect", inspectView: "full" }
            : { generation: 2, dialogId: null, inspectView: null },
      },
    }));
    try {
      await f.store.refresh();
      expect(f.store.getSnapshot().view?.dialogId).toBe("inspect");
      f.state.edit("draft", "changed");
      if (phase === "derived") await f.state.flushForm();
      expect(f.state.derivedCurrent()).toBe(false);
      await f.store.act({ kind: "dialogClose", nodeId: "inspect" });
      expect(f.interact.mock.calls.some(([r]) => r.kind === "dialogClose")).toBe(true);
      expect(f.store.getSnapshot().view?.dialogId).toBeNull();
      expect(
        f.interact.mock.calls.some(([r]) => r.kind === "cursor" || r.kind === "codeCopy"),
      ).toBe(false);
    } finally {
      f.store.dispose();
      f.state.retire();
      f.data.retire();
    }
  },
);
