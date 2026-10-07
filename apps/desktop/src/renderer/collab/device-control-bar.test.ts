// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
