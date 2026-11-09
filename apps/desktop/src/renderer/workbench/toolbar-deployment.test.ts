// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Toolbar } from "./toolbar.js";
import { copy } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
it.each(["en", "zh-TW"] as const)(
  "shows a non-deployable reason without disabling Build in %s",
  async (locale) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const noop = () => {};
    const state: ExecutionState = {
      phase: "idle",
      diagnostics: [],
      logs: [],
      session: { id: "s", name: "EV3", transport: "usb" },
      successfulBuild: { workspaceId: "w", buildId: "b", time: 0, undeployableReason: "BUILD1005" },
    };
    try {
      await act(async () =>
        root.render(
          createElement(Toolbar, {
            t: copy[locale],
            locale,
            theme: "dark",
            appearance: null,
            shortcutHint: () => "",
            name: "demo",
            locked: false,
            canSave: true,
            deviceLocked: false,
            state,
            onSaveAll: noop,
            onNew: noop,
            onOpen: noop,
            onSave: noop,
            onRun: noop,
            onStop: noop,
            onBuild: noop,
            onPreview: noop,
            onUpload: noop,
            onRunUploaded: noop,
            onDelete: noop,
            onCancel: noop,
            onDevice: noop,
          }),
        ),
      );
      const run = container.querySelector<HTMLButtonElement>(".run-button")!;
      expect(run.disabled).toBe(false);
      expect(run.title).toContain(locale === "zh-TW" ? "無法部署" : "cannot deploy");
      const menu = container.querySelector<HTMLButtonElement>(".more-button")!;
      await act(async () => menu.click());
      const build = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === copy[locale].build,
      )!;
      const upload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === copy[locale].uploadLatest,
      )!;
      expect(build.disabled).toBe(false);
      expect(upload.disabled).toBe(true);
      expect(upload.title).toBe(run.title);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
