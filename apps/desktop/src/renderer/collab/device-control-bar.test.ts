// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collabCopy } from "./collab-copy.js";
import { CollabStore } from "./store.js";
import { createLinkedSessions } from "./testing.js";
import { DeviceControl } from "./device-control.js";
import { DeviceControlBar, blockedNotice, useDeviceControl } from "./device-control-bar.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

describe("device control UI bridge", () => {
  it("reports control to main and updates permission actions through grant, release and leave", () => {
    const room = createLinkedSessions(["host", "editor"]);
    const [hostSession, editorSession] = room.sessions;
    const hostControl = new DeviceControl(hostSession!);
    const store = new CollabStore(() => editorSession!);
    const api = { setDeviceControl: vi.fn(async () => {}) };
    function Panel() {
      const device = useDeviceControl(store, api);
      if (!device) return createElement("p", null, "No room");
      return createElement(
        "div",
        null,
        createElement(
          "button",
          { disabled: Boolean(blockedNotice("en", device)), id: "run" },
          "Run",
        ),
        createElement(DeviceControlBar, { ...device, locale: "en" }),
      );
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(createElement(Panel)));
    expect(api.setDeviceControl).toHaveBeenLastCalledWith(null);
    act(() => {
      store.start(editorSession!.connection);
    });
    expect(api.setDeviceControl).toHaveBeenLastCalledWith(false);
    expect(host.querySelector<HTMLButtonElement>("#run")!.disabled).toBe(true);
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;
    act(() => button("Request control").click());
    expect(hostControl.getSnapshot().requests).toHaveLength(1);
    expect(button("Cancel request")).toBeDefined();
    act(() => hostControl.grant(editorSession!.connection.participantId));
    expect(api.setDeviceControl).toHaveBeenLastCalledWith(true);
    expect(host.querySelector<HTMLButtonElement>("#run")!.disabled).toBe(false);
    act(() => button("Give back control").click());
    expect(api.setDeviceControl).toHaveBeenLastCalledWith(false);
    act(() => hostControl.grant(editorSession!.connection.participantId));
    act(() => editorSession!.close("kicked"));
    expect(api.setDeviceControl).toHaveBeenLastCalledWith(false);
    expect(host.querySelector<HTMLButtonElement>("#run")!.disabled).toBe(true);
    act(() => store.stop());
    expect(api.setDeviceControl).toHaveBeenLastCalledWith(null);
    expect(host.textContent).toBe("No room");
    hostControl.dispose();
    hostSession!.destroy();
  });

  it.each(["en", "zh-TW"] as const)(
    "shows pending, decline and disabled reasons visibly (%s)",
    (locale) => {
      const copy = collabCopy[locale];
      const room = createLinkedSessions(["host", "editor", "viewer"]);
      const [hostSession, editorSession, viewerSession] = room.sessions;
      const controls = room.sessions.map((session) => new DeviceControl(session));
      const [hostControl, editorControl, viewerControl] = controls;
      const render = () =>
        act(() =>
          root!.render(
            createElement(
              "div",
              null,
              ...controls.map((control, index) =>
                createElement(
                  "div",
                  { key: index, "data-testid": `bar-${index}` },
                  createElement(DeviceControlBar, {
                    control,
                    state: control.getSnapshot(),
                    locale,
                  }),
                ),
              ),
            ),
          ),
        );
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      const bar = (index: number) => host.querySelector(`[data-testid="bar-${index}"]`)!;
      const find = (index: number, id: string) =>
        bar(index).querySelector<HTMLElement>(`[data-testid="${id}"]`);
      render();

      expect(bar(0).querySelector(".status-dot")!.getAttribute("aria-hidden")).toBe("true");
      // Viewers see why they cannot request control, not just a disabled button.
      const viewerButton = find(2, "device-control-request") as HTMLButtonElement;
      expect(viewerButton.disabled).toBe(true);
      expect(viewerButton.title).toBe("");
      const viewerHint = find(2, "device-control-hint")!;
      expect(viewerHint.textContent).toBe(copy.requestControlViewer);
      expect(viewerButton.getAttribute("aria-describedby")).toBe(viewerHint.id);
      expect(find(1, "device-control-hint")).toBeNull();

      act(() => find(1, "device-control-request")!.click());
      render();
      expect(find(1, "device-control-pending")!.textContent).toBe(copy.controlRequestPending);
      expect(find(1, "device-control-cancel")!.textContent).toBe(copy.cancelControlRequest);
      expect(find(0, "device-control-request-item")!.textContent).toContain(
        copy.controlRequestFrom("User 2"),
      );
      expect(find(0, "device-control-grant")!.textContent).toBe(copy.giveControl);

      act(() => find(0, "device-control-decline")!.click());
      render();
      expect(find(0, "device-control-request-item")).toBeNull();
      expect(find(1, "device-control-pending")).toBeNull();
      expect(find(1, "device-control-declined")!.textContent).toContain(
        copy.controlRequestDeclined,
      );
      expect(editorControl!.getSnapshot().canRequest).toBe(true);
      act(() => find(1, "device-control-declined")!.querySelector("button")!.click());
      render();
      expect(find(1, "device-control-declined")).toBeNull();

      // While disconnected, the visible hint explains the disabled request button.
      act(() => editorSession!.close("left"));
      render();
      const offlineButton = find(1, "device-control-request") as HTMLButtonElement;
      expect(offlineButton.disabled).toBe(true);
      expect(find(1, "device-control-hint")!.textContent).toBe(copy.deviceControlNotConnected);
      expect(offlineButton.getAttribute("aria-describedby")).toBe(
        find(1, "device-control-hint")!.id,
      );

      for (const control of [hostControl, editorControl, viewerControl]) control!.dispose();
      hostSession!.destroy();
      viewerSession!.destroy();
    },
  );
});
