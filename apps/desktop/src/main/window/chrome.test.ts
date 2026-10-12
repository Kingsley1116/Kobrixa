import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}));
import { registerIpc } from "../ipc.js";
import { UpdateOperationGate } from "../updates/service.js";
import { registerWindowChromeIpc } from "./chrome.js";

function setup() {
  const renderer = { id: 1, mainFrame: {} };
  const window = { isDestroyed: vi.fn(() => false), setTitleBarOverlay: vi.fn() };
  const currentWindow = vi.fn((): BrowserWindow | undefined => window as never);
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new UpdateOperationGate(() => undefined),
    undefined,
    undefined,
    undefined,
    [(handle) => registerWindowChromeIpc(handle, currentWindow)],
  );
  return {
    window,
    currentWindow,
    event: { sender: renderer, senderFrame: renderer.mainFrame },
    update: handlers.get("window-chrome:appearance")!,
  };
}

describe("window chrome IPC", () => {
  it("rejects invalid appearance and untrusted senders before changing the window", () => {
    const { window, event, update } = setup();
    const appearance = { theme: "light", height: 78 };
    for (const patch of [
      { theme: "system" },
      { height: 0 },
      { height: 513 },
      { height: 62.5 },
      { height: Infinity },
      { height: "62" },
      { extra: true },
    ])
      expect(() => update(event, { ...appearance, ...patch })).toThrow();
    expect(() => update({ ...event, sender: { id: 2 } }, appearance)).toThrow("untrusted");
    expect(() => update({ ...event, senderFrame: {} }, appearance)).toThrow("untrusted");
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    update(event, appearance);
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({
      color: "#f5f0e7",
      symbolColor: "#1e2933",
      height: 78,
    });
  });

  it("ignores updates after the window has closed", () => {
    const { window, currentWindow, event, update } = setup();
    window.isDestroyed.mockReturnValue(true);
    expect(() => update(event, { theme: "dark", height: 62 })).not.toThrow();
    currentWindow.mockReturnValue(undefined);
    expect(() => update(event, { theme: "dark", height: 62 })).not.toThrow();
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });
});
