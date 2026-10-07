// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";
import { DevicePanel } from "./device-panel.js";
import { Toolbar } from "../workbench/toolbar.js";

const noop = () => {};
afterEach(() => vi.unstubAllGlobals());
describe("USB recovery controls", () => {
  it.each(["en", "zh-TW"] as const)(
    "shows matching status and permits local work in %s",
    async (locale) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const t = copy[locale];
      for (const phase of ["waiting", "connecting"] as const) {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const build = vi.fn(),
          cancel = vi.fn();
        const state: ExecutionState = {
          phase: "idle",
          diagnostics: [],
          logs: [],
          recovery: { sessionId: "old", name: "My EV3", state: phase },
        };
        try {
          await act(async () =>
            root.render(
              createElement(
                Fragment,
                null,
                createElement(DevicePanel, {
                  t,
                  locale,
                  state,
                  devices: [],
                  discovering: false,
                  locked: false,
                  mode: "usb",
                  onMode: noop,
                  selected: undefined,
                  onSelect: noop,
                  address: "",
                  onAddress: noop,
                  onDiscover: noop,
                  onConnect: noop,
                  onDisconnect: cancel,
                  onCancel: noop,
                }),
                createElement(Toolbar, {
                  t,
                  locale,
                  state,
                  appearance: null,
                  shortcutHint: () => "",
                  name: "Robot",
                  locked: false,
                  deviceLocked: false,
                  canSave: true,
                  onSaveAll: noop,
                  onNew: noop,
                  onOpen: noop,
                  onSave: noop,
                  onRun: noop,
                  onStop: noop,
                  onBuild: build,
                  onPreview: noop,
                  onUpload: noop,
                  onRunUploaded: noop,
                  onDelete: noop,
                  onCancel: noop,
                  onDevice: noop,
                }),
              ),
            ),
          );
          const button = (label: string) =>
            [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
          const label =
            phase === "waiting" ? t.connectionStates.waiting : t.connectionStates.reconnecting;
          expect(container.querySelector(".connection-banner")?.textContent).toContain(label);
          expect(container.querySelector(".connection-label")?.textContent).toBe(label);
          expect((container.querySelector(".run-button") as HTMLButtonElement).disabled).toBe(true);
          expect((container.querySelector(".stop-button") as HTMLButtonElement).disabled).toBe(
            true,
          );
          expect(button(t.save).disabled).toBe(false);
          await act(async () =>
            (container.querySelector(".more-button") as HTMLButtonElement).click(),
          );
          expect(button(t.build).disabled).toBe(false);
          expect(button(t.uploadLatest).disabled).toBe(true);
          expect(button(t.runUploaded).disabled).toBe(true);
          await act(async () => button(t.build).click());
          expect(build).toHaveBeenCalledOnce();
          await act(async () => button(t.cancelRecovery).click());
          expect(cancel).toHaveBeenCalledOnce();
        } finally {
          await act(async () => root.unmount());
          container.remove();
        }
      }
    },
  );
});
