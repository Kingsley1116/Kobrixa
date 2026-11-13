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
    disconnect = vi.fn(),
    legacy = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(DevicePanel, {
          t: copy.en,
          locale: "en",
          state: { phase: "awaitingDevice" } as ExecutionState,
          locked: false,
          devices: [],
          mode: "wifi",
          address: "old",
          onDiscover: legacy,
          onConnect: legacy,
          onMode: legacy,
          onAddress: legacy,
          onDisconnect: disconnect,
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
    expect(disconnect).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps recovery cancellation and core status visible without any optional feature", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"),
    root = createRoot(container);
  const disconnect = vi.fn(),
    open = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(DevicePanel, {
          t: copy.en,
          locale: "en",
          locked: true,
          state: {
            phase: "idle",
            recovery: { state: "waiting", name: "Recovering EV3" },
            connectionNotice: "retry-exhausted",
          } as ExecutionState,
          onDisconnect: disconnect,
          onCancel: vi.fn(),
          onOpenConnectionTools: open,
        }),
      ),
    );
    expect(container.textContent).toContain("Recovering EV3");
    expect(container.textContent).toContain("Automatic reconnect attempts exhausted");
    expect(container.querySelector(".version-card")).not.toBeNull();
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === copy.en.cancelRecovery,
    )!;
    expect(cancel.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(disconnect).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(container.querySelector("input, select, .connection-method")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
