// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginUiBridge } from "@kobrixa/plugin-runtime";
import { RendererSession } from "./bootstrap.js";
import { PluginStatusHost } from "./status-host.js";
import { SettingsStore } from "../settings/settings.js";
import { createPluginUiWindow, type PluginUiWindow } from "../settings/settings-state.js";
import {
  binding,
  entry,
  fixture,
  handle,
  labels,
  snapshot,
  validationContext,
} from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, session: RendererSession | undefined;
let windowOwner: PluginUiWindow | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  session?.dispose();
  windowOwner?.dispose();
  windowOwner = undefined;
  root = undefined;
  session = undefined;
  document.body.replaceChildren();
});
async function setup(locale: "en" | "zh-TW", withOpen = false) {
  const f = fixture();
  const panelResource = await f.bridge.resource({
    sourceKey: entry.sourceKey,
    id: entry.id,
    uiResourceGeneration: entry.uiResourceGeneration,
    resourceDigest: entry.resourceDigest,
  });
  const status = { ...entry, id: "acme.ui.status", kind: "status" as const, version: 2 as const };
  const statusBinding = { ...binding, kind: "status" as const, contributionId: status.id };
  f.bridge.catalog.mockResolvedValue({
    ok: true,
    value: {
      hostEpoch: binding.hostEpoch,
      revision: 1,
      entries: withOpen ? [status, entry] : [status],
      nextCursor: null,
    },
  });
  f.bridge.resource.mockResolvedValue({
    ok: true,
    value: {
      owner: status,
      id: status.id,
      version: 2,
      validationContext: {
        ...validationContext,
        panels: [
          {
            id: entry.id,
            title: { en: "Panel" },
            location: "right",
            resource: { version: 1, path: "panel.json" },
          },
        ],
      },
      rawBytes: 1000,
      resource: {
        kind: "status",
        text: { text: { en: "Recording", "zh-TW": "錄製中" } },
        tone: "neutral",
        data: {
          reservation: { schema: { type: "string", maxLength: 36, nullable: true }, initial: null },
        },
        actions: [
          ...(withOpen
            ? [
                {
                  id: "open",
                  label: { en: "Open" },
                  action: {
                    kind: "core" as const,
                    action: "openPanel" as const,
                    panelId: entry.id,
                  },
                },
              ]
            : []),
          {
            id: "stop",
            label: { en: "Stop", "zh-TW": "停止" },
            action: {
              kind: "core",
              action: "stopRecording",
              reservation: { scope: "data", key: "reservation" },
            },
          },
        ],
      },
    },
  });
  f.bridge.snapshot.mockResolvedValue({
    ok: true,
    value: { ...snapshot(), binding: statusBinding, form: {}, data: { reservation: handle(99) } },
  });
  const interact = vi
    .fn<NonNullable<PluginUiBridge["interact"]>>()
    .mockResolvedValue({ ok: true, value: { kind: "control", accepted: true } });
  const settings = new SettingsStore(() => window.localStorage, "en");
  settings.set("rightPanel", "collab");
  if (withOpen) {
    const statusResource = await f.bridge.resource({
      sourceKey: status.sourceKey,
      id: status.id,
      uiResourceGeneration: status.uiResourceGeneration,
      resourceDigest: status.resourceDigest,
    });
    f.bridge.resource.mockImplementation(async (input) =>
      input.id === status.id ? statusResource : panelResource,
    );
    windowOwner = createPluginUiWindow({
      ...f,
      bridge: { ...f.bridge, interact },
      settings,
      storage: window.localStorage,
    });
    session = windowOwner.session;
    await windowOwner.ready;
  } else {
    session = new RendererSession({ ...f.bridge, interact });
    await session.start();
  }
  f.emit({ type: "state", binding: statusBinding, revision: 0 });
  await vi.waitFor(() => expect(session!.record(status)).toBeDefined());
  const div = document.createElement("div");
  document.body.append(div);
  root = createRoot(div);
  await act(async () =>
    root!.render(createElement(PluginStatusHost, { session: session!, locale, labels })),
  );
  await act(async () => {});
  return { ...f, status, statusBinding, interact, settings };
}
it.each(["en", "zh-TW"] as const)(
  "v2 status Stop uses its original binding and no feature command (%s)",
  async (locale) => {
    const f = await setup(locale);
    const button = document.querySelector("button")!;
    expect(button.textContent).toBe(locale === "en" ? "Stop" : "停止");
    await act(async () => button.click());
    expect(f.interact).toHaveBeenCalledExactlyOnceWith({
      kind: "core",
      binding: f.statusBinding,
      actionId: "stop",
    });
    expect(f.bridge.invoke).not.toHaveBeenCalled();
    expect(f.bridge.open).not.toHaveBeenCalled();
  },
);
it("reports a rejected core action instead of displaying success", async () => {
  const f = await setup("en");
  f.interact.mockResolvedValueOnce({
    ok: false,
    error: { code: "PLUGIN_E_STALE_RESOURCE", message: "stale" },
  });
  await act(async () => document.querySelector("button")!.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(labels.unavailable);
});
it("status Open switches the real right-pane setting before opening its declared panel", async () => {
  const f = await setup("en", true);
  expect(f.settings.getSnapshot().values.rightPanel).toBe("collab");
  await act(async () => document.querySelector("button")!.click());
  expect(f.settings.getSnapshot().values.rightPanel).toBe("plugins");
  expect(f.bridge.open).toHaveBeenCalledWith({
    sourceKey: entry.sourceKey,
    id: entry.id,
    uiResourceGeneration: entry.uiResourceGeneration,
  });
  expect(session!.record(entry)).toBeDefined();
});
