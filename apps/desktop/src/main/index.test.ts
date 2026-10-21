import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
it("starts all desktop services under the primary callback", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const gate = source.indexOf("const primary = startPrimary(app");
  expect(gate).toBeGreaterThan(0);
  for (const construction of ["new WorkspaceService(", "await composeDesktopMain(", "new DeviceService(",
    "new MonitorService(", "new SensorLabService(", "await createCollabService("])
    expect(source.indexOf(construction), construction).toBeGreaterThan(gate);
  expect(source).not.toContain("void app.whenReady().then(");
  expect(source).not.toContain("releaseSingleInstanceLock");
});
it("never lets renderer handshake success bypass the main disposition guard", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("() => { void mainClose.request(); }");
  expect(source).not.toContain("updates?.installing || handshake.ready");
});

it("delegates window loss and quit disconnect to the coordinator without legacy reset", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).not.toContain("devices.reset(");
});

it("tears down a USB loss episode once across repeated waiting/unavailable reports", async () => {
  const { createDeviceLossHandler } = await import("./plugins/controller.js");
  const lost = vi.fn(), restored = vi.fn();
  const handle = createDeviceLossHandler(lost, restored);
  const descriptor = { id: "old", name: "EV3", transport: "usb" as const };
  for (const state of ["waiting", "connecting", "waiting", "unavailable", "waiting"] as const)
    handle({ type: "usb-recovery", state, previousSessionId: "old", descriptor });
  expect(lost).toHaveBeenCalledExactlyOnceWith("old");
  handle({ type: "usb-recovery", state: "restored", previousSessionId: "old", sessionId: "new", descriptor, deployment: "none" });
  expect(restored).toHaveBeenCalledExactlyOnceWith("new");
  handle({ type: "usb-recovery", state: "waiting", previousSessionId: "new", descriptor });
  expect(lost.mock.calls).toEqual([["old"], ["new"]]);
});

vi.mock("electron", () => ({ utilityProcess: {}, MessageChannelMain: class {} }));
