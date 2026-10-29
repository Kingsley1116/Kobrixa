// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DevicePanel } from "./device-panel.js";
import { copy } from "../i18n/copy.js";
import type { ExecutionState } from "../execution/execution.js";

it("redirects connection input to public tools while retaining pending-run cancellation and core information", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"),
    root = createRoot(container);
  const open = vi.fn(),
    cancel = vi.fn(),
    mode = vi.fn(),
    connect = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(DevicePanel, {
          t: copy.en,
          locale: "en",
          state: { phase: "awaitingDevice" } as ExecutionState,
          devices: [],
          discovering: false,
          locked: false,
          mode: "wifi",
          onMode: mode,
          selected: undefined,
          onSelect: vi.fn(),
          address: "old",
          onAddress: vi.fn(),
          onDiscover: vi.fn(),
          onConnect: connect,
          onDisconnect: vi.fn(),
          onCancel: cancel,
          onOpenConnectionTools: open,
        }),
      ),
    );
    expect(container.querySelector(".connection-method")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector(".version-card")).not.toBeNull();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Open EV3 plugin tools")!
        .click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".pending-run button")!.click(),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
