// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MonitorPanel } from "./monitor-panel.js";
import type { MonitorController, MonitorState } from "./monitor-controller.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("retains input/output readings and monitor cleanup without any legacy motor controls", () => {
  const state: MonitorState = {
    sessionId: "s",
    active: true,
    status: "live",
    modes: {},
    loadingPort: undefined,
    switchingPort: undefined,
    error: undefined,
    modeError: undefined,
    snapshot: {
      sampledAt: 1,
      battery: { percent: 78, voltage: 7.5 },
      program: { status: "stopped", rawStatus: 0, result: 0 },
      inputs: [],
      outputs: [{ port: 0, type: 7, state: "ready", name: "Large motor", angle: -123 }],
    },
  };
  const configure = vi.fn();
  const controller = {
    subscribe: () => () => {},
    getSnapshot: () => state,
    configure,
  } as unknown as MonitorController;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(MonitorPanel, {
          controller,
          locale: "en",
          active: true,
          sessionId: "s",
          onConnect: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector('[data-testid="monitor-output-0"]')?.textContent).toContain("-123");
    expect(host.querySelector('[data-testid^="motor-test-"]')).toBeNull();
    expect(host.querySelector(".motor-test-controls")).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
  expect(configure).toHaveBeenLastCalledWith("s", false);
});
