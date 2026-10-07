import { describe, expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
  shell: {},
}));
import { registerIpc } from "../ipc.js";
import { UpdateOperationGate, type UpdateService } from "../updates/service.js";
import { DEVICE_CONTROL_DENIED, DeviceControlGate } from "./device-control.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const buildId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const planId = "00000000-0000-4000-8000-000000000004";

function setup() {
  handlers.clear();
  const destroyed: (() => void)[] = [];
  const renderer = {
    id: 7,
    mainFrame: {},
    once: vi.fn((name: string, listener: () => void) => {
      if (name === "destroyed") destroyed.push(listener);
    }),
  };
  const devices = {
    upload: vi.fn(),
    deploy: vi.fn(),
    run: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    files: vi.fn(),
    prepareFiles: vi.fn(),
    executeFiles: vi.fn(),
    stopFiles: vi.fn(),
    monitor: vi.fn(),
    setInputMode: vi.fn(),
    discover: vi.fn(),
    disconnect: vi.fn(),
  };
  const motors = {
    start: vi.fn(),
    stop: vi.fn(),
    keepAlive: vi.fn(),
    getState: vi.fn(),
    flush: vi.fn(),
  };
  const monitor = { setInputMode: vi.fn(), watch: vi.fn() };
  const updates = { preparing: false } as UpdateService;
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    devices as never,
    updates,
    new UpdateOperationGate(() => updates),
    undefined,
    undefined,
    { monitor: monitor as never, lab: {} as never, motors: motors as never },
  );
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> =>
    handlers.get(channel)!(event, ...args);
  return { renderer, devices, motors, monitor, invoke, destroyed };
}

const fileRequest = (action: string) => ({
  sessionId,
  requestId,
  action,
  path: "/home/root/lms2012/prjs",
  locale: "en",
});

const gatedCalls: [string, ...unknown[]][] = [
  ["device:upload", sessionId, buildId, "/a.rbf"],
  ["device:deploy", sessionId, buildId, "/prjs"],
  ["device:run", sessionId, "/a.rbf"],
  ["device:delete", sessionId, "/a.rbf"],
  [
    "device:files-prepare",
    {
      sessionId,
      requestId,
      action: "upload",
      path: "/prjs",
      paths: ["a"],
      source: "files",
      locale: "en",
    },
  ],
  ["device:files-execute", { sessionId, requestId, planId }, "skip"],
  [
    "device:motor-test-start",
    {
      sessionId,
      testId: buildId,
      port: 0,
      power: 20,
      direction: 1,
      mode: "timed",
      durationMs: 1000,
      brake: true,
    },
  ],
  ["device:set-input-mode", sessionId, 0, 16, 0],
  ["device:motor-test-keepalive", { sessionId, testId: buildId }],
  ["device:files", fileRequest("delete")],
  ["device:files", fileRequest("upload")],
];

describe("device control IPC gate", () => {
  it("rejects device writes while another collaborator holds control", async () => {
    const { devices, motors, monitor, invoke } = setup();
    await invoke("collab:set-device-control", false);
    for (const [channel, ...args] of gatedCalls)
      await expect(invoke(channel, ...args), channel).rejects.toThrow(DEVICE_CONTROL_DENIED);
    expect(devices.upload).not.toHaveBeenCalled();
    expect(devices.deploy).not.toHaveBeenCalled();
    expect(devices.run).not.toHaveBeenCalled();
    expect(devices.delete).not.toHaveBeenCalled();
    expect(devices.files).not.toHaveBeenCalled();
    expect(devices.prepareFiles).not.toHaveBeenCalled();
    expect(devices.executeFiles).not.toHaveBeenCalled();
    expect(motors.start).not.toHaveBeenCalled();
    expect(motors.keepAlive).not.toHaveBeenCalled();
    expect(motors.flush).toHaveBeenCalledTimes(1);
    expect(monitor.setInputMode).not.toHaveBeenCalled();

    await invoke("device:stop", sessionId);
    expect(devices.stop).toHaveBeenCalledWith(sessionId);
    await invoke("device:motor-test-stop", { sessionId, testId: buildId }, true);
    expect(motors.stop).toHaveBeenCalled();
    await invoke("device:files-stop", { sessionId, requestId, planId });
    expect(devices.stopFiles).toHaveBeenCalled();
    await invoke("device:files", fileRequest("list"));
    await invoke("device:files", fileRequest("download"));
    expect(devices.files).toHaveBeenCalledTimes(2);
    await invoke("device:monitor", sessionId);
    await invoke("device:discover");
    await invoke("device:disconnect", sessionId);
    expect(devices.monitor).toHaveBeenCalled();
    expect(devices.discover).toHaveBeenCalled();
    expect(devices.disconnect).toHaveBeenCalled();
  });

  it("allows only download batch plans returned by the file service", async () => {
    const { devices, invoke } = setup();
    await invoke("collab:set-device-control", false);
    const ref = { sessionId, requestId, planId };
    // A renderer-provided action cannot relabel an upload plan as a download.
    await expect(
      invoke("device:files-execute", { ...ref, action: "download" }, "skip"),
    ).rejects.toThrow(DEVICE_CONTROL_DENIED);
    devices.prepareFiles.mockResolvedValue({ ...ref, action: "download", phase: "ready" });
    await invoke("device:files-prepare", {
      sessionId,
      requestId,
      action: "download",
      path: "/prjs",
      paths: ["a"],
      source: "files",
      locale: "en",
    });
    await invoke("device:files-execute", ref, "skip");
    expect(devices.executeFiles).toHaveBeenCalledTimes(1);
    await expect(
      invoke("device:files-execute", { ...ref, planId: buildId }, "skip"),
    ).rejects.toThrow(DEVICE_CONTROL_DENIED);
  });

  it("allows device writes when holding control or outside a session", async () => {
    const { devices, invoke } = setup();
    await invoke("collab:set-device-control", true);
    await invoke("device:run", sessionId, "/a.rbf");
    await invoke("collab:set-device-control", false);
    await expect(invoke("device:run", sessionId, "/a.rbf")).rejects.toThrow(DEVICE_CONTROL_DENIED);
    await invoke("collab:set-device-control", null);
    await invoke("device:run", sessionId, "/a.rbf");
    expect(devices.run).toHaveBeenCalledTimes(2);
  });

  it("validates the flag and requires a trusted sender", async () => {
    const { renderer, invoke } = setup();
    for (const value of ["yes", 1, undefined, {}])
      await expect(invoke("collab:set-device-control", value)).rejects.toThrow();
    const handler = handlers.get("collab:set-device-control")!;
    expect(() => handler({ sender: { ...renderer, id: 8 }, senderFrame: {} }, false)).toThrow(
      "untrusted",
    );
  });

  it("clears the flag when the window is destroyed", async () => {
    const { renderer, devices, invoke, destroyed } = setup();
    await invoke("collab:set-device-control", false);
    await invoke("collab:set-device-control", false);
    expect(renderer.once).toHaveBeenCalledTimes(1);
    for (const listener of destroyed) listener();
    await invoke("device:run", sessionId, "/a.rbf");
    expect(devices.run).toHaveBeenCalled();
  });
});

describe("DeviceControlGate", () => {
  it("tracks flags per web contents", () => {
    const gate = new DeviceControlGate();
    const sender = (id: number) => ({ id, once: vi.fn() }) as never;
    gate.set(sender(1), false);
    gate.set(sender(2), true);
    expect(() => gate.assert(1, "device:run", [])).toThrow(DEVICE_CONTROL_DENIED);
    expect(() => gate.assert(2, "device:run", [])).not.toThrow();
    expect(() => gate.assert(3, "device:run", [])).not.toThrow();
    expect(() => gate.assert(1, "device:stop", [])).not.toThrow();
    expect(gate.get(1)).toBe(false);
    gate.set(sender(1), null);
    expect(gate.get(1)).toBeNull();
  });
});
