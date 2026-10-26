// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreRecoverySnapshot } from "@kobrixa/plugin-runtime";
import { fixture, entry, handle, deferred } from "../plugin-ui/contract.test.js";
import { CoreRecoveryView } from "../plugin-ui/core-recovery.js";
import { PluginToolsPane } from "../plugin-ui/panel-host.js";
import { SettingsStore } from "./settings.js";
import { createPluginUiWindow, pluginUiWindow, settingsStore } from "./settings-state.js";
import { pluginRecoveryPort } from "./plugins-panel.js";
import { pluginUiCopy } from "./plugin-copy.js";
import { CorePersistenceRecovery } from "../plugin-ui/core-persistence-detail.js";
import type { PluginsApi } from "../../shared/plugins.js";

it("mounts persistence detail with all optional features off", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let open: (input: { itemId: string }) => void = () => {};
  const off = vi.fn();
  const port: PluginsApi["persistenceRecovery"] = {
    snapshot: vi.fn<PluginsApi["persistenceRecovery"]["snapshot"]>(async () => ({
      ok: true,
      value: { revision: 0, items: [] },
    })),
    act: vi.fn<PluginsApi["persistenceRecovery"]["act"]>(async () => ({
      ok: true,
      value: { revision: 0, items: [] },
    })),
    onOpen: vi.fn((listener) => {
      open = listener;
      return off;
    }),
    onChanged: vi.fn(() => off),
  };
  const element = document.createElement("div");
  const detailRoot = createRoot(element);
  try {
    await act(async () =>
      detailRoot.render(createElement(CorePersistenceRecovery, { port, labels: pluginUiCopy.en })),
    );
    await act(async () => open({ itemId: "00000000-0000-4000-8000-000000000001" }));
    expect(port.snapshot).toHaveBeenCalledWith({ itemId: "00000000-0000-4000-8000-000000000001" });
  } finally {
    await act(async () => detailRoot.unmount());
  }
  expect(off).toHaveBeenCalledTimes(2);
});

const layoutKey = "kobrixa.layout.pluginPanel";
function backing(initial: Record<string, string> = {}) {
  const saved = new Map(Object.entries(initial));
  return {
    saved,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
}
const owners: Array<{ dispose(): void }> = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup(initial: Record<string, string> = {}) {
  const f = fixture();
  const storage = backing(initial);
  const settings = new SettingsStore(() => storage, "en");
  const owner = createPluginUiWindow({ ...f, settings, storage });
  owners.push(owner);
  return { ...f, storage, settings, owner };
}

async function beginPendingHold(
  owner: ReturnType<typeof createPluginUiWindow>,
  bridge: ReturnType<typeof fixture>["bridge"],
  kind: "pointer" | "key" = "pointer",
) {
  const record = owner.session.record(entry)!;
  await vi.waitFor(() => expect(record.state.getSnapshot().busy).toBe(false));
  const pending = deferred<Awaited<ReturnType<typeof bridge.hold>>>();
  bridge.hold.mockReturnValueOnce(pending.promise);
  const count = bridge.hold.mock.calls.length;
  expect(
    record.intent.begin("hold", {
      trusted: true,
      kind,
      id: kind === "key" ? "Enter" : "1",
      primary: true,
      repeat: false,
    }),
  ).toBe(true);
  // A later gesture first reconciles the preceding submission through snapshot.
  await vi.waitFor(() => expect(bridge.hold.mock.calls.length).toBe(count + 1));
  expect(bridge.hold.mock.calls.at(-1)![0].phase).toBe("begin");
  expect(record.state.getSnapshot().busy).toBe(true);
  return async () => {
    pending.resolve({ ok: true, value: { gesture: handle(4) } });
    await vi.waitFor(() => expect(record.state.getSnapshot().busy).toBe(false));
  };
}

it("U09/U15 cancels a pending hold before pane notifications and settings/modal hiding", async () => {
  const { bridge, owner, settings, storage } = setup();
  await owner.ready;
  settings.set("rightPanel", "plugins");
  await owner.session.open(entry);
  const off = settings.subscribe(() => {
    expect(bridge.hold.mock.calls.at(-1)![0].phase).toBe("cancel");
    expect(bridge.visibility.mock.calls.at(-1)![0].visible).toBe(false);
  });
  let settle = await beginPendingHold(owner, bridge);
  settings.set("rightPanel", "collab");
  off();
  await settle();
  for (const gate of ["settings", "modal"] as const) {
    settings.set("rightPanel", "plugins");
    settle = await beginPendingHold(owner, bridge);
    owner.gate(gate, true);
    expect(bridge.hold.mock.calls.at(-1)![0].phase).toBe("cancel");
    expect(bridge.visibility.mock.calls.at(-1)![0].visible).toBe(false);
    const count = bridge.visibility.mock.calls.length;
    owner.gate(gate, true);
    expect(bridge.visibility).toHaveBeenCalledTimes(count);
    await settle();
    owner.gate(gate, false);
  }
  settle = await beginPendingHold(owner, bridge);
  settings.resetLayout();
  expect(bridge.hold.mock.calls.at(-1)![0].phase).toBe("cancel");
  expect(bridge.visibility.mock.calls.at(-1)![0]).toMatchObject({
    visible: false,
    reason: "collapse",
  });
  expect(JSON.parse(storage.saved.get(layoutKey)!)).toEqual([entry.sourceKey, entry.id]);
  expect(storage.saved.get(layoutKey)).not.toMatch(/processEpoch|panelInstance|speed|command/);
  await settle();
});

it("U11/U15 restores eligible selection without opening, replaying or duplicating subscriptions", async () => {
  const { bridge, owner, listeners, settings } = setup({
    [layoutKey]: JSON.stringify([entry.sourceKey, entry.id]),
  });
  await owner.ready;
  expect(owner.session.selectedKey()).toBe(JSON.stringify([entry.sourceKey, entry.id]));
  expect(bridge.open).not.toHaveBeenCalled();
  expect(bridge.invoke).not.toHaveBeenCalled();
  expect(bridge.resource).not.toHaveBeenCalled();
  await owner.host.start();
  expect(bridge.onEvent).toHaveBeenCalledOnce();
  owner.dispose();
  owner.dispose();
  settings.set("rightPanel", "plugins");
  expect(listeners.size).toBe(0);
  expect(bridge.visibility).not.toHaveBeenCalled();
});

it.each([
  "not-json",
  '["one"]',
  '["a",1]',
  JSON.stringify([entry.sourceKey, "missing"]),
  " ".repeat(1025),
])("ignores invalid or absent saved contribution identity %s", async (raw) => {
  const { owner, bridge } = setup({ [layoutKey]: raw });
  await owner.ready;
  expect(owner.session.selectedKey()).toBeNull();
  expect(bridge.open).not.toHaveBeenCalled();
});

it("does not restore an unavailable panel or resurrect a disposed bootstrap", async () => {
  const f = fixture();
  f.bridge.catalog.mockResolvedValue({
    ok: true,
    value: {
      hostEpoch: handle(1),
      revision: 1,
      entries: [{ ...entry, availability: "unavailable" }],
      nextCursor: null,
    },
  });
  const storage = backing({ [layoutKey]: JSON.stringify([entry.sourceKey, entry.id]) });
  const settings = new SettingsStore(() => storage, "en");
  const owner = createPluginUiWindow({ ...f, settings, storage });
  owners.push(owner);
  await owner.ready;
  expect(owner.session.selectedKey()).toBeNull();
  const other = setup({ [layoutKey]: JSON.stringify([entry.sourceKey, entry.id]) });
  other.owner.dispose();
  await other.owner.ready;
  expect(other.owner.session.selectedKey()).toBeNull();
  expect(other.listeners.size).toBe(0);
});

it("uses one window owner and revokes on blur/document hide, then removes window listeners", async () => {
  const f = fixture();
  vi.stubGlobal("kobrixa", { plugins: { ui: f.bridge, recovery: f.recovery } });
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const owner = pluginUiWindow();
  owners.push(owner);
  expect(pluginUiWindow()).toBe(owner);
  await owner.ready;
  settingsStore.set("rightPanel", "plugins");
  await owner.session.open(entry);
  let settle = await beginPendingHold(owner, f.bridge, "key");
  focus.mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  expect(f.bridge.hold.mock.calls.at(-1)![0].phase).toBe("cancel");
  await settle();
  focus.mockReturnValue(true);
  window.dispatchEvent(new Event("focus"));
  settle = await beginPendingHold(owner, f.bridge, "key");
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(f.bridge.hold.mock.calls.at(-1)![0].phase).toBe("cancel");
  await settle();
  window.dispatchEvent(new Event("pagehide"));
  expect(f.listeners.size).toBe(0);
  expect(f.bridge.close).toHaveBeenCalledOnce();
  const count = f.bridge.visibility.mock.calls.length;
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  settingsStore.resetLayout();
  expect(f.bridge.visibility).toHaveBeenCalledTimes(count);
});

const recoverySnapshot: CoreRecoverySnapshot = {
  hostEpoch: handle(1),
  revision: 1,
  nextCursor: null,
  items: [
    {
      id: handle(20),
      sourceKey: entry.sourceKey,
      kind: "process",
      state: "process-failed",
      title: { en: "Process failed" },
      detail: { en: "Reload or disable in plugin settings" },
      actions: [{ id: handle(21), kind: "manage" }],
    },
  ],
};

it("mounts real recovery while UI bootstrap hangs and routes only acknowledged manage to settings", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = fixture();
  f.bridge.catalog.mockImplementation(() => new Promise(() => {}));
  f.recovery.snapshot.mockResolvedValue({ ok: true, value: recoverySnapshot });
  f.recovery.act.mockResolvedValue({ ok: true, value: recoverySnapshot });
  const storage = backing();
  const settings = new SettingsStore(() => storage, "en");
  const owner = createPluginUiWindow({ ...f, storage, settings });
  owners.push(owner);
  const manage = vi.fn();
  const port = pluginRecoveryPort(owner.recovery, manage);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          "div",
          {},
          createElement(CoreRecoveryView, { port, locale: "en", labels: pluginUiCopy.en }),
          createElement(PluginToolsPane, {
            session: owner.session,
            locale: "en",
            labels: pluginUiCopy.en,
            onClose: vi.fn(),
          }),
        ),
      ),
    );
    expect(container.querySelector('[data-state="process-failed"]')?.textContent).toContain(
      "Process failed",
    );
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === pluginUiCopy.en.actions.manage,
    )!;
    await act(async () => button.click());
    expect(f.recovery.act).toHaveBeenCalledWith({ itemId: handle(20), actionId: handle(21) });
    expect(manage).toHaveBeenCalledOnce();
    expect(f.bridge.open).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await owner.ready;
    });
    expect(container.querySelector('[data-core-recovery="true"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["rejected", "missing-item", "different-action", "device-action"])(
  "does not navigate from a %s recovery reply",
  async (kind) => {
    const f = fixture();
    const manage = vi.fn();
    const item = recoverySnapshot.items[0]!;
    f.recovery.act.mockResolvedValue(
      kind === "rejected"
        ? { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Retired" } }
        : {
            ok: true,
            value: {
              ...recoverySnapshot,
              items:
                kind === "missing-item"
                  ? []
                  : [
                      {
                        ...item,
                        actions: [
                          {
                            id: kind === "different-action" ? handle(22) : handle(21),
                            kind: kind === "device-action" ? "stop" : "manage",
                          },
                        ],
                      },
                    ],
            },
          },
    );
    const result = await pluginRecoveryPort(f.recovery, manage).act({
      itemId: item.id,
      actionId: handle(21),
    });
    expect(result).toBe(await f.recovery.act.mock.results[0]!.value);
    expect(manage).not.toHaveBeenCalled();
  },
);
